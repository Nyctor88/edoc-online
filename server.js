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

// Note: Ensure this points to 'edoc' (Linux) or 'edoc.exe' (Windows)
// If running on Render/Linux, use 'edoc'
const COMPILER_PATH = path.join(__dirname, "edoc");

app.post("/compile", (req, res) => {
  const code = req.body.code;
  const tempFile = path.join(__dirname, "temp_code.txt");
  fs.writeFileSync(tempFile, code);

  // Run the interpreter
  exec(`${COMPILER_PATH} < ${tempFile}`, (error, stdout, stderr) => {
    fs.unlinkSync(tempFile); // Cleanup

    if (error) {
      return res.json({
        output: `Error: ${stderr || error.message}`,
        mips: "Error during compilation",
        binary: "Error during compilation",
      });
    }

    // --- MOCK DATA GENERATION ---
    // Since your parser is an interpreter, it doesn't create these files real-time.
    // For the purpose of the project/UI demo, we can generate a simple message
    // or a fake representation here.

    const mipsOutput = `
# MIPS Assembly (Generated)
.data
    val_a: .word 10
    val_b: .word 5
.text
    main:
        lw $t0, val_a
        lw $t1, val_b
        add $t2, $t0, $t1  # Addition logic
        li $v0, 1
        move $a0, $t2
        syscall
        li $v0, 10
        syscall
        `;

    const machineCode = `
00101010 11010101 00000000 00010100
10101010 00001111 11001100 11110000
00000000 00000000 00000000 00000000
11111111 11111111 11111111 11111111
        `;

    // Send all three back to the frontend
    res.json({
      output: stdout,
      mips: mipsOutput, // Sends the mock MIPS
      binary: machineCode, // Sends the mock Binary
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
