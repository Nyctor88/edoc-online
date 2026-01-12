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

// --- NEW: EXPRESSION PARSER (Shunting-Yard Algorithm) ---
// This converts "a + b * c" into "a b c * +" (RPN) so we can generate ASM easily.

function tokenize(expr) {
  // Regex matches: numbers, variables, operators, parentheses
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
      // It's a number or variable
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
      operatorStack.pop(); // Pop '('
    }
  });

  while (operatorStack.length > 0) {
    outputQueue.push(operatorStack.pop());
  }
  return outputQueue;
}

// --- NEW: ASM GENERATOR FOR COMPLEX MATH ---
function generateComplexASM(expr, machineCodeOutput) {
  // 1. Handle Unary Minus (Hack: replace "-a" with "0 - a" if at start)
  //    Simple clean up for common unary cases in stress test
  expr = expr.replace(/^-\s*([a-zA-Z0-9]+)/, "0 - $1");
  expr = expr.replace(/\(-\s*([a-zA-Z0-9]+)/g, "(0 - $1");

  const tokens = tokenize(expr);
  const rpn = shuntingYard(tokens);

  let asm = "";
  let regStack = []; // Stack to track which register holds the value
  let currentReg = 8; // Start using temps from R8 upwards (R8-R23)

  rpn.forEach((token) => {
    if (!isNaN(parseInt(token))) {
      // Immediate: Load into next available register
      let val = parseInt(token);
      let reg = currentReg++;
      asm += `DADDIU R${reg}, R0, #${val}\n`;
      let b = encodeIType(25, 0, reg, val);
      machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      regStack.push(reg);
    } else if (/^[a-zA-Z_]/.test(token)) {
      // Variable: Load into next available register
      let reg = currentReg++;
      asm += `LD R${reg}, ${token}(R0)\n`;
      let b = encodeLD(reg, 0, 0);
      machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      regStack.push(reg);
    } else {
      // Operator: Pop two registers, compute, push result register
      let rRight = regStack.pop();
      let rLeft = regStack.pop();
      let rRes = currentReg++; // New result register

      if (token === "+") {
        asm += `DADDU R${rRes}, R${rLeft}, R${rRight}\n`;
        let b = encodeRType(0, rLeft, rRight, rRes, 0, 45);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      } else if (token === "-") {
        asm += `DSUBU R${rRes}, R${rLeft}, R${rRight}\n`;
        let b = encodeRType(0, rLeft, rRight, rRes, 0, 47);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      } else if (token === "*") {
        asm += `DMULTU R${rLeft}, R${rRight}\n`;
        let b = encodeRType(0, rLeft, rRight, 0, 0, 29);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;

        asm += `MFLO R${rRes}\n`;
        let b2 = encodeRType(0, 0, 0, rRes, 0, 18);
        machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
      } else if (token === "/") {
        asm += `DDIVU R${rLeft}, R${rRight}\n`;
        let b = encodeRType(0, rLeft, rRight, 0, 0, 31);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;

        asm += `MFLO R${rRes}\n`;
        let b2 = encodeRType(0, 0, 0, rRes, 0, 18);
        machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
      }
      regStack.push(rRes);
    }
  });

  // The result is in the last register on stack
  let finalReg = regStack.pop();

  // Move to R4 (Standard output/result location for our convention)
  if (finalReg !== 4) {
    // We use DADDU R4, Rfinal, R0 to move
    asm += `DADDU R4, R${finalReg}, R0\n`;
    let b = encodeRType(0, finalReg, 0, 4, 0, 45);
    machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
  }

  return asm;
}

// --- MAIN ENGINE ---
function generateEduMIPS(sourceCode) {
  const lines = sourceCode.split("\n");
  let dataSection = ".data\n";
  let codeSection = ".code\n";
  let machineCodeOutput = { code: "" };

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

    // 1. DECLARATIONS
    if (line.startsWith("var.") || line.startsWith("const.")) {
      const parts = line.replace(/,/g, " ").replace(/=/g, " ").split(/\s+/);
      let currentVar = null;
      for (let i = 2; i < parts.length; i++) {
        let token = parts[i];
        if (
          token === "var." ||
          token === "const." ||
          token === "int" ||
          token === "float"
        )
          continue;

        if (!currentVar) {
          currentVar = token;
          dataSection += `${currentVar}: .dword\n`;
        } else {
          let val = parseInt(token); // Truncates floats to ints for MIPS safety
          if (isNaN(val)) val = 0;

          codeSection += `DADDIU R1, R0, #${val}\n`;
          let bin1 = encodeIType(25, 0, 1, val);
          machineCodeOutput.code += `${bin1} (${binToHex(bin1)})\n`;

          codeSection += `SD R1, ${currentVar}(R0)\n`;
          let bin2 = encodeSD(1, 0, 0);
          machineCodeOutput.code += `${bin2} (${binToHex(bin2)})\n`;

          currentVar = null;
        }
      }
    }

    // 2. ASSIGNMENTS
    else if (line.includes("=") && !line.startsWith("dsply")) {
      const sides = line.split("=");
      const target = sides[0].trim();
      const expr = sides[1].trim();

      if (/[+\-*/]/.test(expr)) {
        // Complex Math
        codeSection += generateComplexASM(expr, machineCodeOutput);
        // Store Result (R4)
        codeSection += `SD R4, ${target}(R0)\n`;
        let b = encodeSD(4, 0, 0);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      } else {
        // Simple Assignment
        let val = parseInt(expr);
        if (!isNaN(val)) {
          codeSection += `DADDIU R1, R0, #${val}\n`;
          let b = encodeIType(25, 0, 1, val);
          machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
          codeSection += `SD R1, ${target}(R0)\n`;
          let b2 = encodeSD(1, 0, 0);
          machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
        }
      }
    }

    // 3. PRINTING
    else if (line.startsWith("dsply@")) {
      let content = line.match(/\[(.*?)\]/)[1].trim();

      if (/[+\-*/]/.test(content)) {
        // Complex Math Printing
        codeSection += generateComplexASM(content, machineCodeOutput);
        // Result is already in R4 from generateComplexASM
      } else {
        // Single Variable
        codeSection += `LD R4, ${content}(R0)\n`;
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

  // 1. Generate eduMIPS Translations
  const translations = generateEduMIPS(code);

  // 2. Run Actual Interpreter
  fs.writeFileSync(tempFile, code);
  exec(`${COMPILER_PATH} < ${tempFile}`, (error, stdout, stderr) => {
    fs.unlinkSync(tempFile);
    const finalOutput = error ? `Error: ${stderr || error.message}` : stdout;

    res.json({
      output: finalOutput,
      mips: translations.mips,
      binary: translations.binary,
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
