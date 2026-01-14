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
// Opcode 40 (0x28) is SB (Store Byte)
function encodeSB(rt, base, offset) {
  return encodeIType(40, base, rt, offset);
}
// Opcode 36 (0x24) is LBU (Load Byte Unsigned) - Used to read chars
function encodeLBU(rt, base, offset) {
  return encodeIType(36, base, rt, offset);
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
  const constantVars = new Set();
  const charVars = new Set();

  // Register Manager
  let tempRegCount = 0;
  const getNextReg = () => {
    tempRegCount++;
    return tempRegCount;
  };
  const resetTemps = () => {
    tempRegCount = 0;
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    let line = lines[lineIdx].trim();
    const lineNum = lineIdx + 1;

    if (
      !line ||
      line.startsWith("boot") ||
      line.startsWith("end") ||
      line.startsWith("//") ||
      line.startsWith("#")
    )
      continue;

    // 1. DECLARATIONS
    const declMatch = line.match(/^(var|const)\s*\.\s*(int|float|char)\b/);

    if (declMatch) {
      resetTemps();
      const isConst = declMatch[1] === "const";
      // --- FIX #1: Use index 2 for the type ---
      const type = declMatch[2];

      const hasAssignment = line.includes("=");
      const rightSide = hasAssignment ? line.split("=")[1].trim() : "";
      const isComplex = hasAssignment && /[+\-*/]/.test(rightSide);

      if (isComplex) {
        const leftSide = line.split("=")[0].trim();
        const prefix = leftSide.match(
          /^(var|const)\s*\.\s*(int|float|char)\s+/
        )[0];
        const varName = leftSide.replace(prefix, "").trim();

        if (!varName)
          throw new Error(`Line ${lineNum}: Missing variable name.`);
        if (isConst) constantVars.add(varName);
        if (type === "char") charVars.add(varName);

        if (type === "char") dataSection += `    ${varName}: .byte\n`;
        else dataSection += `    ${varName}: .dword\n`;

        let result = generateComplexASM(
          rightSide,
          machineCodeOutput,
          getNextReg
        );
        codeSection += result.asm;

        if (type === "char") {
          codeSection += `    SB R${result.reg}, ${varName}(R0)\n`;
          let b = encodeSB(result.reg, 0, 0);
          machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
        } else {
          codeSection += `    SD R${result.reg}, ${varName}(R0)\n`;
          let b = encodeSD(result.reg, 0, 0);
          machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
        }
      } else {
        // --- FIX #2: Use index 2 here as well ---
        let cleanLine = line.replace(
          declMatch[0],
          `${declMatch[1]}.${declMatch[2]} `
        );

        const parts = cleanLine
          .replace(/,/g, " ")
          .replace(/=/g, " ")
          .split(/\s+/);
        let currentVar = null;

        for (let i = 0; i < parts.length; i++) {
          let token = parts[i];
          if (/^(var|const)\.(int|float|char)$/.test(token) || token === "")
            continue;

          if (!currentVar) {
            currentVar = token;
            if (isConst) constantVars.add(currentVar);
            if (type === "char") charVars.add(currentVar);

            if (type === "char") dataSection += `    ${currentVar}: .byte\n`;
            else dataSection += `    ${currentVar}: .dword\n`;
          } else {
            let val;
            if (
              (token.startsWith('"') && token.endsWith('"')) ||
              (token.startsWith("'") && token.endsWith("'"))
            ) {
              let cleanChar = token.substring(1, token.length - 1);
              val = cleanChar.charCodeAt(0);
            } else {
              val = parseInt(token);
            }

            if (isNaN(val))
              throw new Error(
                `Line ${lineNum}: Invalid value assigned to '${currentVar}'.`
              );

            let reg = getNextReg();
            codeSection += `    DADDIU R${reg}, R0, #${val}\n`;
            let b = encodeIType(25, 0, reg, val);
            machineCodeOutput.code += `${b} (${binToHex(b)})\n`;

            if (charVars.has(currentVar)) {
              codeSection += `    SB R${reg}, ${currentVar}(R0)\n`;
              let b2 = encodeSB(reg, 0, 0);
              machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
            } else {
              codeSection += `    SD R${reg}, ${currentVar}(R0)\n`;
              let b2 = encodeSD(reg, 0, 0);
              machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
            }
            currentVar = null;
          }
        }
      }
    }

    // 2. ASSIGNMENTS
    else if (
      /^([a-zA-Z0-9_]+)\s*(\+=|-=|\*=|\/=|=)\s*(.+)$/.test(line) &&
      !line.startsWith("dsply")
    ) {
      resetTemps();
      const match = line.match(/^([a-zA-Z0-9_]+)\s*(\+=|-=|\*=|\/=|=)\s*(.+)$/);
      const target = match[1];
      const operator = match[2];
      let expr = match[3];

      if (constantVars.has(target)) {
        throw new Error(
          `Line ${lineNum}: Error. Cannot reassign constant '${target}'.`
        );
      }

      if (operator !== "=") {
        const mathOp = operator.charAt(0);
        expr = `${target} ${mathOp} (${expr})`;
      }

      if (/[+\-*/]/.test(expr)) {
        let result = generateComplexASM(expr, machineCodeOutput, getNextReg);
        codeSection += result.asm;

        if (charVars.has(target)) {
          codeSection += `    SB R${result.reg}, ${target}(R0)\n`;
          let b = encodeSB(result.reg, 0, 0);
          machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
        } else {
          codeSection += `    SD R${result.reg}, ${target}(R0)\n`;
          let b = encodeSD(result.reg, 0, 0);
          machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
        }
      } else {
        let val;
        expr = expr.trim();
        if (
          (expr.startsWith('"') && expr.endsWith('"')) ||
          (expr.startsWith("'") && expr.endsWith("'"))
        ) {
          let cleanChar = expr.substring(1, expr.length - 1);
          val = cleanChar.charCodeAt(0);
        } else {
          val = parseInt(expr);
        }

        if (isNaN(val))
          throw new Error(`Line ${lineNum}: Invalid assignment value.`);

        let reg = getNextReg();
        codeSection += `    DADDIU R${reg}, R0, #${val}\n`;
        let b = encodeIType(25, 0, reg, val);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;

        if (charVars.has(target)) {
          codeSection += `    SB R${reg}, ${target}(R0)\n`;
          let b2 = encodeSB(reg, 0, 0);
          machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
        } else {
          codeSection += `    SD R${reg}, ${target}(R0)\n`;
          let b2 = encodeSD(reg, 0, 0);
          machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
        }
      }
    }

    // 3. PRINTING
    else if (line.startsWith("dsply@")) {
      resetTemps();
      let match = line.match(/\[(.*?)\]/);

      if (!match || !match[1] || match[1].trim() === "") {
        throw new Error(
          `Syntax Error on line ${lineNum}: dsply@[] cannot be empty.`
        );
      }

      let content = match[1].trim();

      if (/[+\-*/]/.test(content)) {
        let result = generateComplexASM(content, machineCodeOutput, getNextReg);
        codeSection += result.asm;
      }
      // Single var is silent
    }

    // 4. STRING PRINT
    else if (line.startsWith("dsply")) {
      if (!line.includes('"')) {
        throw new Error(
          `Syntax Error on line ${lineNum}: Use 'dsply@' to print variables.`
        );
      }
    } else {
      throw new Error(
        `Syntax Error on line ${lineNum}: Unknown statement "${line}".`
      );
    }
  }

  return { mips: dataSection + codeSection, binary: machineCodeOutput.code };
}

// --- API ENDPOINT ---
app.post("/compile", (req, res) => {
  const code = req.body.code;
  const tempFile = path.join(__dirname, "temp_code.txt");

  let translations;

  // 1. Try to Transpile
  try {
    translations = generateEduMIPS(code);
  } catch (err) {
    // STOP EVERYTHING IF ERROR FOUND
    return res.json({
      output: `Error: ${err.message}`, // The clean error message
      mips: "", // Hide MIPS
      binary: "", // Hide Binary
    });
  }

  // 2. If Transpilation Succeeded, Run Actual Interpreter
  fs.writeFileSync(tempFile, code);
  exec(`${COMPILER_PATH} < ${tempFile}`, (error, stdout, stderr) => {
    // Cleanup temp file
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

    let finalOutput = stdout;

    if (stderr) {
      finalOutput += `\n--- Errors ---\n${stderr}`;
    }
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
