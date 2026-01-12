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
  let bin = (num >>> 0).toString(2); // Handle unsigned shift
  while (bin.length < bits) bin = "0" + bin;
  return bin.slice(-bits); // Ensure fit
}

function binToHex(binStr) {
  let hex = parseInt(binStr, 2).toString(16).toUpperCase();
  while (hex.length < 8) hex = "0" + hex;
  return "0x" + hex;
}

// --- EDU-MIPS64 TRANSPILER ENGINE ---
function generateEduMIPS(sourceCode) {
  const lines = sourceCode.split("\n");

  let dataSection = ".data\n";
  let textSection = ".text\n.globl main\nmain:\n";
  let machineCodeOutput = "";

  // Register Map for simple allocation
  // $0=zero, $t0-$t9=temp. We'll map EDOC vars to memory addresses (Labels)
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

    // 1. DECLARATIONS: var. int x = 10 -> x: .word64 10
    if (line.startsWith("var.") || line.startsWith("const.")) {
      // Remove keywords and parse
      const parts = line.replace(/,/g, " ").replace(/=/g, " ").split(/\s+/);
      // Expected format loosely: var. int name value

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
        } else {
          let val = parseInt(token);
          if (isNaN(val)) val = 0;

          // ASM Output
          dataSection += `    ${currentVar}: .word64 ${val}\n`;
          currentVar = null;
        }
      }
    }

    // 2. ASSIGNMENTS / MATH: total = A + B
    else if (line.includes("=") && !line.startsWith("dsply")) {
      // Simple Parser: supports "VAR = VAL", "VAR = VAR", "VAR = VAR op VAR"
      const sides = line.split("=");
      const target = sides[0].trim();
      const expr = sides[1].trim();

      let asm = "";
      let bin = [];

      // Case A: Binary Math (A + B)
      if (
        expr.includes("+") ||
        expr.includes("-") ||
        expr.includes("*") ||
        expr.includes("/")
      ) {
        let op = "";
        if (expr.includes("+")) op = "+";
        else if (expr.includes("-")) op = "-";
        else if (expr.includes("*")) op = "*";
        else if (expr.includes("/")) op = "/";

        const ops = expr.split(op);
        const op1 = ops[0].trim();
        const op2 = ops[1].trim();

        // Load Operand 1 into $t0
        asm += `    ld $t0, ${op1}\n`;
        bin.push(encodeLD(8, 0, 0)); // Placeholder offset calculation usually required

        // Load Operand 2 into $t1
        asm += `    ld $t1, ${op2}\n`;
        bin.push(encodeLD(9, 0, 0));

        // Perform Op
        if (op === "+") {
          asm += `    daddu $t2, $t0, $t1\n`;
          bin.push(encodeRType(0, 8, 9, 10, 0, 45)); // DADDU
        } else if (op === "-") {
          asm += `    dsubu $t2, $t0, $t1\n`;
          bin.push(encodeRType(0, 8, 9, 10, 0, 47)); // DSUBU
        } else if (op === "*") {
          asm += `    dmultu $t0, $t1\n`;
          bin.push(encodeRType(0, 8, 9, 0, 0, 29)); // DMULTU
          asm += `    mflo $t2\n`;
          bin.push(encodeRType(0, 0, 0, 10, 0, 18)); // MFLO
        } else if (op === "/") {
          asm += `    ddivu $t0, $t1\n`;
          bin.push(encodeRType(0, 8, 9, 0, 0, 31)); // DDIVU
          asm += `    mflo $t2\n`;
          bin.push(encodeRType(0, 0, 0, 10, 0, 18)); // MFLO
        }

        // Store Result
        asm += `    sd $t2, ${target}\n`;
        bin.push(encodeSD(10, 0, 0));
      }
      // Case B: Direct Assignment (x = 5)
      else if (!isNaN(parseInt(expr))) {
        let val = parseInt(expr);
        asm += `    daddiu $t0, $zero, ${val}\n`;
        bin.push(encodeIType(25, 0, 8, val)); // DADDIU

        asm += `    sd $t0, ${target}\n`;
        bin.push(encodeSD(8, 0, 0));
      }

      textSection += asm;
      bin.forEach((b) => {
        machineCodeOutput += `${b}  (${binToHex(b)})\n`;
      });
    }

    // 3. PRINTING: dsply@[x]
    else if (line.startsWith("dsply@")) {
      let content = line.match(/\[(.*?)\]/)[1];

      // Syscall 1 (Print Int)
      let asm = `    ld $a0, ${content}\n`;
      let bin = [encodeLD(4, 0, 0)];

      asm += `    daddiu $v0, $zero, 1\n`;
      bin.push(encodeIType(25, 0, 2, 1)); // DADDIU $v0, $zero, 1

      asm += `    syscall\n`;
      bin.push("00000000000000000000000000001100"); // SYSCALL code

      textSection += asm;
      bin.forEach((b) => {
        machineCodeOutput += `${b}  (${binToHex(b)})\n`;
      });
    }
  });

  // Exit Call
  textSection += `    daddiu $v0, $zero, 10\n    syscall\n`;
  machineCodeOutput += `${encodeIType(25, 0, 2, 10)}  (${binToHex(
    encodeIType(25, 0, 2, 10)
  )})\n`;
  machineCodeOutput += `00000000000000000000000000001100  (0x0000000C)\n`;

  return { mips: dataSection + "\n" + textSection, binary: machineCodeOutput };
}

// --- BINARY ENCODING HELPERS (MIPS64 SPEC) ---

// R-Type: opcode(6) rs(5) rt(5) rd(5) shamt(5) funct(6)
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

// I-Type: opcode(6) rs(5) rt(5) immediate(16)
function encodeIType(opcode, rs, rt, imm) {
  return toBin(opcode, 6) + toBin(rs, 5) + toBin(rt, 5) + toBin(imm, 16);
}

// LD (Load Double): Opcode 55 (110111)
function encodeLD(rt, base, offset) {
  return encodeIType(55, base, rt, offset);
}

// SD (Store Double): Opcode 63 (111111)
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
