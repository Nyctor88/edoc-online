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

// --- HELPER: MATH GENERATOR (Reused for Assignments and Display) ---
// Generates assembly to calculate "op1 operator op2" and put result in R4
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

  // Load Operand 1 into R2
  asm += `LD R2, ${op1}(R0)\n`;
  let b1 = encodeLD(2, 0, 0);
  machineCodeOutput.code += `${b1} (${binToHex(b1)})\n`;

  // Load Operand 2 into R3
  asm += `LD R3, ${op2}(R0)\n`;
  let b2 = encodeLD(3, 0, 0);
  machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;

  // Perform Op -> Result in R4
  if (op === "+") {
    asm += `DADDU R4, R2, R3\n`;
    let b3 = encodeRType(0, 2, 3, 4, 0, 45);
    machineCodeOutput.code += `${b3} (${binToHex(b3)})\n`;
  } else if (op === "-") {
    asm += `DSUBU R4, R2, R3\n`;
    let b3 = encodeRType(0, 2, 3, 4, 0, 47);
    machineCodeOutput.code += `${b3} (${binToHex(b3)})\n`;
  } else if (op === "*") {
    asm += `DMULTU R2, R3\n`;
    let b3 = encodeRType(0, 2, 3, 0, 0, 29);
    machineCodeOutput.code += `${b3} (${binToHex(b3)})\n`;
    asm += `MFLO R4\n`;
    let b4 = encodeRType(0, 0, 0, 4, 0, 18);
    machineCodeOutput.code += `${b4} (${binToHex(b4)})\n`;
  } else if (op === "/") {
    asm += `DDIVU R2, R3\n`;
    let b3 = encodeRType(0, 2, 3, 0, 0, 31);
    machineCodeOutput.code += `${b3} (${binToHex(b3)})\n`;
    asm += `MFLO R4\n`;
    let b4 = encodeRType(0, 0, 0, 4, 0, 18);
    machineCodeOutput.code += `${b4} (${binToHex(b4)})\n`;
  }

  return { asm: asm, valid: true };
}

// --- EDU-MIPS64 TRANSPILER ENGINE ---
function generateEduMIPS(sourceCode) {
  const lines = sourceCode.split("\n");
  let dataSection = ".data\n";
  let codeSection = ".code\n";

  // We use an object to pass the string by reference
  let machineCodeOutput = { code: "" };

  let variables = {};

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
          variables[currentVar] = true;
          dataSection += `${currentVar}: .dword\n`;
        } else {
          let val = parseInt(token);
          if (isNaN(val)) val = 0;

          codeSection += `DADDIU R1, R0, #${val}\n`;
          codeSection += `SD R1, ${currentVar}(R0)\n`;

          let bin1 = encodeIType(25, 0, 1, val);
          machineCodeOutput.code += `${bin1} (${binToHex(bin1)})\n`;

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

      // Try to generate Math ASM
      let mathResult = generateMathASM(expr, machineCodeOutput);

      if (mathResult.valid) {
        // If it was math, result is in R4. Store it to target.
        codeSection += mathResult.asm;
        codeSection += `SD R4, ${target}(R0)\n`;
        let b5 = encodeSD(4, 0, 0);
        machineCodeOutput.code += `${b5} (${binToHex(b5)})\n`;
      }
      // If not math, simple assignment (x = 5)
      else if (!isNaN(parseInt(expr))) {
        let val = parseInt(expr);
        codeSection += `DADDIU R1, R0, #${val}\n`;
        let b1 = encodeIType(25, 0, 1, val);
        machineCodeOutput.code += `${b1} (${binToHex(b1)})\n`;

        codeSection += `SD R1, ${target}(R0)\n`;
        let b2 = encodeSD(1, 0, 0);
        machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;
      }
    }

    // 3. PRINTING (FIXED LOGIC)
    else if (line.startsWith("dsply@")) {
      let content = line.match(/\[(.*?)\]/)[1];

      // Check if content is an expression (contains + - * /)
      let mathResult = generateMathASM(content, machineCodeOutput);

      if (mathResult.valid) {
        // Case A: Printing an Expression (a + b)
        // The math logic puts result in R4.
        // We just need to syscall print R4.
        codeSection += mathResult.asm;

        // Print R4
        // Note: Syscall expects value in specific register.
        // If we assume R4 is the print arg, we are good.
      } else {
        // Case B: Printing a Single Variable (total)
        codeSection += `LD R4, ${content}(R0)\n`;
        let b1 = encodeLD(4, 0, 0);
        machineCodeOutput.code += `${b1} (${binToHex(b1)})\n`;
      }

      // Standard Print Syscall setup
      codeSection += `DADDIU R2, R0, #1\n`;
      let b2 = encodeIType(25, 0, 2, 1);
      machineCodeOutput.code += `${b2} (${binToHex(b2)})\n`;

      codeSection += `SYSCALL\n`;
      let b3 = "00000000000000000000000000001100";
      machineCodeOutput.code += `${b3} (${binToHex(b3)})\n`;
    }
  });

  // Exit Call
  codeSection += `DADDIU R2, R0, #10\nSYSCALL\n`;
  let exitBin = encodeIType(25, 0, 2, 10);
  machineCodeOutput.code += `${exitBin} (${binToHex(exitBin)})\n`;
  machineCodeOutput.code += `00000000000000000000000000001100 (0x0000000C)\n`;

  return { mips: dataSection + codeSection, binary: machineCodeOutput.code };
}

// --- BINARY ENCODING HELPERS ---
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
