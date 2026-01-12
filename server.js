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
// Use 'edoc' for Linux/Render, 'edoc.exe' for Windows
const isWindows = process.platform === "win32";
const COMPILER_PATH = path.join(__dirname, isWindows ? "edoc.exe" : "edoc");

// --- 1. MIPS TRANSLATION LOGIC (The "Second Engine") ---
function generateTranslations(sourceCode) {
  const lines = sourceCode.split("\n");
  let mipsData = ".data\n";
  let mipsText = ".text\n.globl main\nmain:\n";
  let machineCode = "";

  // Simple symbol table to track variables
  let variables = {};

  lines.forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith("boot") || line.startsWith("end")) return;

    // A. Handle Declarations: var. int x = 10
    if (line.startsWith("var.") || line.startsWith("const.")) {
      const parts = line.replace(/,/g, "").split(/\s+/); // Remove commas, split by space
      // primitive parsing logic for demo
      let type = parts[1]; // int, float

      // Find variable names and values
      // Example: var. int a = 10
      let currentVar = null;
      for (let i = 2; i < parts.length; i++) {
        if (parts[i] === "=" || parts[i] === "const.") continue;

        if (!currentVar) {
          currentVar = parts[i];
          variables[currentVar] = 0; // Default 0
          mipsData += `    ${currentVar}: .word 0\n`;
        } else {
          // This part is the value
          let val = parseInt(parts[i]);
          if (!isNaN(val)) {
            mipsText += `    li $t0, ${val}\n`;
            mipsText += `    sw $t0, ${currentVar}\n`;
            machineCode += `2408${toHex(val, 4)} (li $t0, ${val})\n`; // addiu $t0, $zero, val
            machineCode += `AC08${toHex(0, 4)} (sw $t0, ${currentVar})\n`;
          }
          currentVar = null; // Reset for next var in list
        }
      }
    }

    // B. Handle Assignments / Math: x = a + b
    // Note: This is a simplified generator for the presentation
    if (
      line.includes("=") &&
      !line.startsWith("var") &&
      !line.startsWith("const")
    ) {
      const sides = line.split("=");
      const target = sides[0].trim();
      const expr = sides[1].trim(); // e.g., "a + b"

      if (expr.includes("+")) {
        const operands = expr.split("+");
        mipsText += `    lw $t0, ${operands[0].trim()}\n`;
        mipsText += `    lw $t1, ${operands[1].trim()}\n`;
        mipsText += `    add $t2, $t0, $t1\n`;
        mipsText += `    sw $t2, ${target}\n`;

        machineCode += `8C080000 (lw $t0)\n8C090000 (lw $t1)\n01095020 (add $t2, $t0, $t1)\nAC0A0000 (sw $t2)\n`;
      } else if (expr.includes("-")) {
        const operands = expr.split("-");
        mipsText += `    lw $t0, ${operands[0].trim()}\n`;
        mipsText += `    lw $t1, ${operands[1].trim()}\n`;
        mipsText += `    sub $t2, $t0, $t1\n`;
        mipsText += `    sw $t2, ${target}\n`;

        machineCode += `8C080000 (lw $t0)\n8C090000 (lw $t1)\n01095022 (sub $t2, $t0, $t1)\nAC0A0000 (sw $t2)\n`;
      } else {
        // Simple assignment: x = 10 or x = y
        if (!isNaN(parseInt(expr))) {
          mipsText += `    li $t0, ${expr}\n`;
          mipsText += `    sw $t0, ${target}\n`;
        }
      }
    }

    // C. Handle Display: dsply@[x]
    if (line.startsWith("dsply@")) {
      let content = line.match(/\[(.*?)\]/)[1]; // Get content inside []

      // Determine if it's a variable or math
      if (variables[content] !== undefined || !content.includes(" ")) {
        // It's a single variable
        mipsText += `    li $v0, 1\n`;
        mipsText += `    lw $a0, ${content}\n`;
        mipsText += `    syscall\n`;

        machineCode += `24020001 (li $v0, 1)\n8C040000 (lw $a0)\n0000000C (syscall)\n`;
      } else {
        // It's an expression like a + b
        // For presentation, we assume the math puts result in $t2
        mipsText += `    # Expression printing\n`;
        mipsText += `    li $v0, 1\n`;
        mipsText += `    move $a0, $t2\n`;
        mipsText += `    syscall\n`;
        machineCode += `24020001 (li $v0, 1)\n000A2021 (move $a0, $t2)\n0000000C (syscall)\n`;
      }
    }
  });

  // End Program
  mipsText += `    li $v0, 10\n    syscall\n`;
  machineCode += `2402000A (li $v0, 10)\n0000000C (syscall)\n`;

  return { mips: mipsData + mipsText, binary: machineCode };
}

// Helper to convert number to Hex
function toHex(num, padding) {
  let hex = Number(num).toString(16).toUpperCase();
  while (hex.length < padding) hex = "0" + hex;
  return hex;
}

// --- 2. API ENDPOINT ---
app.post("/compile", (req, res) => {
  const code = req.body.code;
  const tempFile = path.join(__dirname, "temp_code.txt");

  // Generate Assembly & Machine Code (JS Engine)
  const translations = generateTranslations(code);

  // Run Actual Interpreter (C Engine)
  fs.writeFileSync(tempFile, code);
  exec(`${COMPILER_PATH} < ${tempFile}`, (error, stdout, stderr) => {
    fs.unlinkSync(tempFile);

    // Combine inputs
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
