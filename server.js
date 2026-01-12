const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// SERVE THE FRONTEND (Your index.html)
app.use(express.static("public"));

// Path to the compiled Linux binary (Note: No '.exe')
const COMPILER_PATH = path.join(__dirname, "edoc");

app.post("/compile", (req, res) => {
  const code = req.body.code;

  // Save to a temp file
  const tempFile = path.join(__dirname, "temp_code.txt");
  fs.writeFileSync(tempFile, code);

  // Run the compiler (Linux style)
  exec(`${COMPILER_PATH} < ${tempFile}`, (error, stdout, stderr) => {
    fs.unlinkSync(tempFile); // Cleanup

    if (error) {
      return res.json({ output: `Error: ${stderr || error.message}` });
    }
    res.json({ output: stdout });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
