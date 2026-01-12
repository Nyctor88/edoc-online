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

// --- HELPER: BINARY & HEX CONVERTERS ---
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

// --- HELPER: ENCODING ---
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

// --- HELPER: SMART LOADER ---
function loadValueIntoRegister(valStr, regNum, machineCodeOutput) {
  let asm = "";
  // Check if it's a number (Immediate)
  if (!isNaN(parseInt(valStr))) {
    let val = parseInt(valStr);
    asm += `DADDIU R${regNum}, R0, #${val}\n`;
    let b = encodeIType(25, 0, regNum, val);
    machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
  }
  // It's a Variable (Label)
  else {
    asm += `LD R${regNum}, ${valStr}(R0)\n`;
    let b = encodeLD(regNum, 0, 0);
    machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
  }
  return asm;
}

// --- HELPER: MATH GENERATOR ---
function generateMathASM(expr, machineCodeOutput) {
  let asm = "";
  let op = "";
  if (expr.includes("+")) op = "+";
  else if (expr.includes("-")) op = "-";
  else if (expr.includes("*")) op = "*";
  else if (expr.includes("/")) op = "/";

  if (!op) return { asm: "", valid: false };

  const ops = expr.split(op);
  const op1 = ops[0].trim();
  const op2 = ops[1].trim();

  // 1. Load Operands safely (R2 and R3)
  asm += loadValueIntoRegister(op1, 2, machineCodeOutput);
  asm += loadValueIntoRegister(op2, 3, machineCodeOutput);

  // 2. Perform Op -> Result in R4
  if (op === "+") {
    asm += `DADDU R4, R2, R3\n`;
    let b = encodeRType(0, 2, 3, 4, 0, 45);
    machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
  } else if (op === "-") {
    asm += `DSUBU R4, R2, R3\n`;
    let b = encodeRType(0, 2, 3, 4, 0, 47);
    machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
  } else if (op === "*") {
    asm += `DMULTU R2, R3\n`;
    let b = encodeRType(0, 2, 3, 0, 0, 29);
    machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
    asm += `MFLO R4\n`;
    let b2 = encodeRType(0, 0, 0, 4, 0, 18);
    machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
  } else if (op === "/") {
    asm += `DDIVU R2, R3\n`;
    let b = encodeRType(0, 2, 3, 0, 0, 31);
    machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
    asm += `MFLO R4\n`;
    let b2 = encodeRType(0, 0, 0, 4, 0, 18);
    machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
  }

  return { asm: asm, valid: true };
}

// --- MAIN TRANSPILER ENGINE ---
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
          let val = parseInt(token);
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

      let mathResult = generateMathASM(expr, machineCodeOutput);

      if (mathResult.valid) {
        codeSection += mathResult.asm;
        codeSection += `SD R4, ${target}(R0)\n`;
        let b = encodeSD(4, 0, 0);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      } else {
        codeSection += loadValueIntoRegister(expr, 1, machineCodeOutput);
        codeSection += `SD R1, ${target}(R0)\n`;
        let b = encodeSD(1, 0, 0);
        machineCodeOutput.code += `${b} (${binToHex(b)})\n`;
      }
    }

    // 3. PRINTING (CLEAN: Logic Only, No Syscalls)
    else if (line.startsWith("dsply@")) {
      let content = line.match(/\[(.*?)\]/)[1].trim();
      const isMath = /[+\-*/]/.test(content);

      if (isMath) {
        let mathResult = generateMathASM(content, machineCodeOutput);
        codeSection += mathResult.asm;
        // No syscall here
      } else {
        codeSection += loadValueIntoRegister(content, 4, machineCodeOutput);
        // No syscall here
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
