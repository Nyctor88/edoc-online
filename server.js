const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// PATH CONFIGURATION
const isWindows = process.platform === "win32";
const COMPILER_PATH = path.join(__dirname, isWindows ? "edoc.exe" : "edoc");

// --- HELPER: BINARY ENCODING ---
function toBin(num, bits) {
  let bin = (num >>> 0).toString(2);
  while (bin.length < bits) bin = "0" + bin;
  return bin.slice(-bits);
}
function binToHex(binStr) {
  let hex = parseInt(binStr, 2).toString(16).toUpperCase();
  while (hex.length < 8) hex = "0" + hex;
  return "0x" + hex;
}
function encodeRType(opcode, rs, rt, rd, shamt, funct) {
  return (
    toBin(opcode, 6) +
    toBin(rs, 5) +
    toBin(rt, 5) +
    toBin(rd, 5) +
    toBin(shamt, 5) +
    toBin(funct, 6)
  );
}
function encodeIType(opcode, rs, rt, imm) {
  return toBin(opcode, 6) + toBin(rs, 5) + toBin(rt, 5) + toBin(imm, 16);
}
function encodeLD(rt, base, offset) {
  return encodeIType(55, base, rt, offset);
}
function encodeSD(rt, base, offset) {
  return encodeIType(63, base, rt, offset);
}

// --- EXPRESSION PARSER (Shunting-Yard) ---
function tokenize(expr) {
  const regex = /([0-9]+)|([a-zA-Z_][a-zA-Z0-9_]*)|([\+\-\*\/])|(\()|(\))/g;
  let tokens = [];
  let match;
  while ((match = regex.exec(expr)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

function shuntingYard(tokens) {
  let outputQueue = [];
  let operatorStack = [];
  const precedence = { "*": 3, "/": 3, "+": 2, "-": 2 };

  tokens.forEach((token) => {
    if (!isNaN(parseInt(token)) || /^[a-zA-Z_]/.test(token)) {
      outputQueue.push(token);
    } else if (token in precedence) {
      while (
        operatorStack.length > 0 &&
        operatorStack[operatorStack.length - 1] !== "(" &&
        precedence[operatorStack[operatorStack.length - 1]] >= precedence[token]
      ) {
        outputQueue.push(operatorStack.pop());
      }
      operatorStack.push(token);
    } else if (token === "(") {
      operatorStack.push(token);
    } else if (token === ")") {
      while (
        operatorStack.length > 0 &&
        operatorStack[operatorStack.length - 1] !== "("
      ) {
        outputQueue.push(operatorStack.pop());
      }
      operatorStack.pop();
    }
  });

  while (operatorStack.length > 0) {
    outputQueue.push(operatorStack.pop());
  }
  return outputQueue;
}

// --- ASM GENERATOR ---
function generateComplexASM(expr, machineCodeOutput, getNextReg) {
  // Unary Minus Hack
  expr = expr.replace(/^-\s*([a-zA-Z0-9]+)/, "0 - $1");
  expr = expr.replace(/\(-\s*([a-zA-Z0-9]+)/g, "(0 - $1");

  const tokens = tokenize(expr);
  const rpn = shuntingYard(tokens);

  let asm = "";
  let regStack = [];

  rpn.forEach((token) => {
    if (!isNaN(parseInt(token))) {
      // Immediate
      let val = parseInt(token);
      let reg = getNextReg();
      asm += `    DADDIU R${reg}, R0, #${val}\n`;
      let b = encodeIType(25, 0, reg, val);
      machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      regStack.push(reg);
    } else if (/^[a-zA-Z_]/.test(token)) {
      // Variable
      let reg = getNextReg();
      asm += `    LD R${reg}, ${token}(R0)\n`;
      let b = encodeLD(reg, 0, 0);
      machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      regStack.push(reg);
    } else {
      // Operator
      let rRight = regStack.pop();
      let rLeft = regStack.pop();
      let rRes = getNextReg();

      if (token === "+") {
        asm += `    DADDU R${rRes}, R${rLeft}, R${rRight}\n`;
        let b = encodeRType(0, rLeft, rRight, rRes, 0, 45);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      } else if (token === "-") {
        asm += `    DSUBU R${rRes}, R${rLeft}, R${rRight}\n`;
        let b = encodeRType(0, rLeft, rRight, rRes, 0, 47);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      } else if (token === "*") {
        asm += `    DMULTU R${rLeft}, R${rRight}\n`;
        let b = encodeRType(0, rLeft, rRight, 0, 0, 29);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;

        asm += `    MFLO R${rRes}\n`;
        let b2 = encodeRType(0, 0, 0, rRes, 0, 18);
        machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
      } else if (token === "/") {
        asm += `    DDIVU R${rLeft}, R${rRight}\n`;
        let b = encodeRType(0, rLeft, rRight, 0, 0, 31);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;

        asm += `    MFLO R${rRes}\n`;
        let b2 = encodeRType(0, 0, 0, rRes, 0, 18);
        machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
      }
      regStack.push(rRes);
    }
  });

  // Return the generated code AND the register where the result lives
  return { asm: asm, reg: regStack.pop() };
}

// --- MAIN ENGINE ---
function generateEduMIPS(sourceCode) {
  const lines = sourceCode.split("\n");
  let dataSection = ".data\n";
  let codeSection = ".code\n";

  let machineCodeOutput = { code: "" };

  // Register Manager
  let tempRegCount = 0;
  const getNextReg = () => {
    tempRegCount++;
    return tempRegCount;
  };
  const resetTemps = () => {
    tempRegCount = 0;
  };

  lines.forEach((line) => {
    line = line.trim();
    if (
      !line ||
      line.startsWith("boot") ||
      line.startsWith("end") ||
      line.startsWith("//") ||
      line.startsWith("#")
    )
      return;

    // Matches "var.int", "var . int", "var. int" etc.
    const declMatch = line.match(/^(var|const)\s*\.\s*(int|float|char)\b/);

    if (declMatch) {
      resetTemps();

      // If the line contains an '=' and math operators (+, -, *, /) on the right side
      // we handle it as a complex assignment, NOT a simple list.
      const hasAssignment = line.includes("=");
      const rightSide = hasAssignment ? line.split("=")[1].trim() : "";
      const isComplex = hasAssignment && /[+\-*/]/.test(rightSide);

      if (isComplex) {
        // Handle: "var.int result = total / groups"

        // 1. Extract the variable name
        const leftSide = line.split("=")[0].trim();
        // Remove the "var . int" prefix to get just the name
        const prefix = leftSide.match(
          /^(var|const)\s*\.\s*(int|float|char)\s+/
        )[0];
        const varName = leftSide.replace(prefix, "").trim();

        // 2. Register in .data
        dataSection += `    ${varName}: .dword\n`;

        // 3. Generate Math Code for the expression
        let result = generateComplexASM(
          rightSide,
          machineCodeOutput,
          getNextReg
        );
        codeSection += result.asm;

        // 4. Store the result
        codeSection += `    SD R${result.reg}, ${varName}(R0)\n`;
        let b = encodeSD(result.reg, 0, 0);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      } else {
        // Handles: "var.int a = 5" or "var.int a=1, b=2"
        // Normalize the line: Force "var . int" -> "var.int" to simplify parsing
        let cleanLine = line.replace(
          declMatch[0],
          `${declMatch[1]}.${declMatch[2]} `
        );

        // Split by space/comma/equal
        const parts = cleanLine
          .replace(/,/g, " ")
          .replace(/=/g, " ")
          .split(/\s+/);

        let currentVar = null;

        for (let i = 0; i < parts.length; i++) {
          let token = parts[i];

          // Skip keywords
          if (
            token === "var.int" ||
            token === "var.float" ||
            token === "var.char" ||
            token === "const.int" ||
            token === "const.float" ||
            token === "const.char" ||
            token === ""
          )
            continue;

          if (!currentVar) {
            // Found Variable Name
            currentVar = token;
            dataSection += `    ${currentVar}: .dword\n`;
          } else {
            // Found Value (Must be a simple number in this loop)
            let val = parseInt(token);
            if (isNaN(val)) val = 0;

            let reg = getNextReg();
            codeSection += `    DADDIU R${reg}, R0, #${val}\n`;
            let bin1 = encodeIType(25, 0, reg, val);
            machineCodeOutput.code += `${bin1} (${binToHex(bin1)})\n`;

            codeSection += `    SD R${reg}, ${currentVar}(R0)\n`;
            let bin2 = encodeSD(reg, 0, 0);
            machineCodeOutput.code += `${bin2} (${binToHex(bin2)})\n`;

            currentVar = null;
          }
        }
      }
    }

    // --- Assignments & Compound Operators (+=, -=) ---
    else if (
      /^([a-zA-Z0-9_]+)\s*(\+=|-=|\*=|\/=|=)\s*(.+)$/.test(line) &&
      !line.startsWith("dsply")
    ) {
      resetTemps();

      const match = line.match(/^([a-zA-Z0-9_]+)\s*(\+=|-=|\*=|\/=|=)\s*(.+)$/);
      const target = match[1];
      const operator = match[2];
      let expr = match[3];

      if (operator !== "=") {
        const mathOp = operator.charAt(0);
        expr = `${target} ${mathOp} (${expr})`;
      }

      if (/[+\-*/]/.test(expr)) {
        let result = generateComplexASM(expr, machineCodeOutput, getNextReg);
        codeSection += result.asm;
        codeSection += `    SD R${result.reg}, ${target}(R0)\n`;
        let b = encodeSD(result.reg, 0, 0);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      } else {
        let val = parseInt(expr);
        if (!isNaN(val)) {
          let reg = getNextReg();
          codeSection += `    DADDIU R${reg}, R0, #${val}\n`;
          let b = encodeIType(25, 0, reg, val);
          machineCodeOutput.code += `${b} (${binToHex(b)})\n`;

          codeSection += `    SD R${reg}, ${target}(R0)\n`;
          let b2 = encodeSD(reg, 0, 0);
          machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
        }
      }
    }

    // --- Printing ---
    else if (line.startsWith("dsply@")) {
      resetTemps();
      let content = line.match(/\[(.*?)\]/)[1].trim();

      if (/[+\-*/]/.test(content)) {
        let result = generateComplexASM(content, machineCodeOutput, getNextReg);
        codeSection += result.asm;
      } else {
        codeSection += `    LD R4, ${content}(R0)\n`;
        let b = encodeLD(4, 0, 0);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      }
    }
  });

  return { mips: dataSection + codeSection, binary: machineCodeOutput.code };
}

// --- API ENDPOINT ---
app.post("/compile", (req, res) => {
  const code = req.body.code;
  const tempFile = path.join(__dirname, "temp_code.txt");

  // 1. Generate eduMIPS Translations (Wrapped in Try-Catch for safety)
  let translations = { mips: "", binary: "" };
  try {
    translations = generateEduMIPS(code);
  } catch (err) {
    translations.mips = `Transpiler Error: ${err.message}`;
    translations.binary = "Error generating binary.";
  }

  // 2. Run Actual Interpreter
  fs.writeFileSync(tempFile, code);
  exec(`${COMPILER_PATH} < ${tempFile}`, (error, stdout, stderr) => {
    // Cleanup temp file
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

    let finalOutput = stdout;

    // If 'stderr' has content (like "Syntax Error"), append it to output
    if (stderr) {
      finalOutput += `\n--- Errors ---\n${stderr}`;
    }

    // If 'error' exists (Execution crash/timeout), append that too
    if (error) {
      finalOutput += `\n--- System Error ---\n${error.message}`;
    }

    res.json({
      output: finalOutput || "No Output (Check your code)",
      mips: translations.mips,
      binary: translations.binary,
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
