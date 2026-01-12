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

// --- REGISTER MANAGER (Matches C Logic) ---
let tempRegCount = 0;

function resetTemps() {
  tempRegCount = 0;
}

function allocateTemp() {
  tempRegCount++;
  return tempRegCount; // Returns 1, 2, 3... (Matches R1, R2, R3...)
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
// Now returns { asm: string, reg: number } instead of forcing a move to R4
function generateComplexASM(expr, machineCodeOutput) {
  // Unary Minus Hack (same as before)
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
      let reg = allocateTemp(); // Get next sequential register
      asm += `DADDIU R${reg}, R0, #${val}\n`;
      let b = encodeIType(25, 0, reg, val);
      machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      regStack.push(reg);
    } else if (/^[a-zA-Z_]/.test(token)) {
      // Variable
      let reg = allocateTemp();
      asm += `LD R${reg}, ${token}(R0)\n`;
      let b = encodeLD(reg, 0, 0);
      machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      regStack.push(reg);
    } else {
      // Operator
      let rRight = regStack.pop();
      let rLeft = regStack.pop();
      let rRes = allocateTemp(); // New temp for result

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

  // Return the generated code AND the register where the result lives
  return { asm: asm, reg: regStack.pop() };
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
      resetTemps(); // Reset register counter for new statement
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
          let val = parseInt(token);
          if (isNaN(val)) val = 0;

          let reg = allocateTemp(); // R1
          codeSection += `DADDIU R${reg}, R0, #${val}\n`;
          let bin1 = encodeIType(25, 0, reg, val);
          machineCodeOutput.code += `${bin1} (${binToHex(bin1)})\n`;

          codeSection += `SD R${reg}, ${currentVar}(R0)\n`;
          let bin2 = encodeSD(reg, 0, 0);
          machineCodeOutput.code += `${bin2} (${binToHex(bin2)})\n`;

          currentVar = null;
        }
      }
    }

    // 2. ASSIGNMENTS
    else if (line.includes("=") && !line.startsWith("dsply")) {
      resetTemps(); // Reset register counter
      const sides = line.split("=");
      const target = sides[0].trim();
      const expr = sides[1].trim();

      if (/[+\-*/]/.test(expr)) {
        // Complex Math
        let result = generateComplexASM(expr, machineCodeOutput);
        codeSection += result.asm;

        // DIRECT STORE: Use the result register directly (Removes extra move)
        codeSection += `SD R${result.reg}, ${target}(R0)\n`;
        let b = encodeSD(result.reg, 0, 0);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      } else {
        // Simple Assignment
        let val = parseInt(expr);
        if (!isNaN(val)) {
          let reg = allocateTemp();
          codeSection += `DADDIU R${reg}, R0, #${val}\n`;
          let b = encodeIType(25, 0, reg, val);
          machineCodeOutput.code += `${b} (${binToHex(b)})\n`;

          codeSection += `SD R${reg}, ${target}(R0)\n`;
          let b2 = encodeSD(reg, 0, 0);
          machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
        }
      }
    }

    // 3. PRINTING
    else if (line.startsWith("dsply@")) {
      resetTemps(); // Reset register counter
      let content = line.match(/\[(.*?)\]/)[1].trim();

      if (/[+\-*/]/.test(content)) {
        let result = generateComplexASM(content, machineCodeOutput);
        codeSection += result.asm;

        // If the result isn't in R4 (Arg register), move it there
        if (result.reg !== 4) {
          codeSection += `DADDU R4, R${result.reg}, R0\n`;
          let b = encodeRType(0, result.reg, 0, 4, 0, 45);
          machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
        }
      } else {
        // Single Variable
        codeSection += `LD R4, ${content}(R0)\n`;
        let b = encodeLD(4, 0, 0);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      }

      // Syscall Print logic (Optional: can remove if you want clean code)
      /*
            codeSection += `DADDIU R2, R0, #1\n`;
            let b1 = encodeIType(25, 0, 2, 1); 
            machineCodeOutput.code += `${b1} (${binToHex(b1)})\n`;

            codeSection += `SYSCALL\n`;
            let b2 = '00000000000000000000000000001100'; 
            machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
            */
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
