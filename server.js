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

// =============================================================
//  PART 1: CONSTANTS & TOKEN DEFINITIONS (Inspired by C Enums)
// =============================================================
const TokenType = {
  KEYWORD: "KEYWORD",
  VARIABLE: "VARIABLE",
  INTEGER: "INTEGER",
  CHAR_LITERAL: "CHAR_LITERAL", // Added for your current project
  OPERATOR: "OPERATOR",
  DELIMITER: "DELIMITER",
  STRING_LITERAL: "STRING_LITERAL", // For dsply ["text"]
  UNKNOWN: "UNKNOWN",
};

const KEYWORDS = [
  "boot",
  "end",
  "var",
  "const",
  "int",
  "float",
  "char",
  "dsply",
  "dsply@",
];

// =============================================================
//  PART 2: HELPERS (Binary & Hex)
// =============================================================
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

// =============================================================
//  PART 3: THE COMPILER SIMULATOR CLASS
//  (Encapsulates Symbol Table, Tokenizer, Parser, CodeGen)
// =============================================================
class CompilerSimulator {
  constructor() {
    this.tokens = [];
    this.pos = 0;
    this.symbolTable = []; // Array of { name, type, addr, isConst }
    this.currentAddr = 0;
    this.dataSection = ".data\n";
    this.codeSection = ".code\n";
    this.binaryOutput = "";
    this.tempRegCount = 0;
  }

  // --- 3.1: SYMBOL TABLE HELPERS ---
  addSymbol(name, type, isConst) {
    if (this.findSymbol(name)) {
      throw new Error(`Redeclaration of variable '${name}'`);
    }

    let addr = this.currentAddr;
    // In your C code, you incremented by 8 (dword).
    // For this project, we do 8 for ints/floats, 1 for char (optional, but sticking to 8 aligns memory easier)
    // Let's stick to your previous .byte logic for chars though to match MIPS logic.
    let size = type === "char" ? 1 : 8;

    this.symbolTable.push({ name, type, addr, isConst });

    // Update Data Section String
    let directive = type === "char" ? ".byte" : ".dword";
    this.dataSection += `    ${name}: ${directive}\n`; // Address info could be added as comment

    // MIPS often aligns data, but for simulation we just increment
    this.currentAddr += size;
  }

  findSymbol(name) {
    return this.symbolTable.find((s) => s.name === name);
  }

  getTempReg() {
    this.tempRegCount++;
    return `R${this.tempRegCount}`;
  }

  resetTempRegs() {
    this.tempRegCount = 0;
  }

  // --- 3.2: MACHINE CODE WRITER (Ported from C) ---
  emitInstruction(instr, rd, rs, rt, imm, asm_instr, comment) {
    let opcode = 0,
      funct = 0,
      machine = 0;

    // Map instructions to OpCodes (Matching your C structure)
    if (instr === "DADDIU") {
      opcode = 0b011001;
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff);
    } else if (instr === "DADDU") {
      opcode = 0b000000;
      funct = 0b101101;
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | (rd << 11) | funct;
    } else if (instr === "DSUBU") {
      opcode = 0b000000;
      funct = 0b101111;
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | (rd << 11) | funct;
    } else if (instr === "DMULTU") {
      opcode = 0b000000;
      funct = 0b011101;
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | funct;
    } else if (instr === "DDIVU") {
      opcode = 0b000000;
      funct = 0b011111;
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | funct;
    } else if (instr === "LD") {
      opcode = 0b110111;
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff);
    } else if (instr === "SD") {
      opcode = 0b111111;
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff);
    } else if (instr === "MFLO") {
      opcode = 0b000000;
      funct = 0b010010;
      machine = (opcode << 26) | (0 << 21) | (0 << 16) | (rd << 11) | funct;
    }
    // Added for your current project (Char support)
    else if (instr === "SB") {
      opcode = 0b101000; // 0x28
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff);
    } else if (instr === "LBU") {
      opcode = 0b100100; // 0x24
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff);
    }

    let binStr = toBin(machine, 32);
    let hexStr = binToHex(binStr);

    this.codeSection += `    ${asm_instr}\n`;
    this.binaryOutput += `${binStr} (${hexStr})\n`;
  }

  // --- 3.3: TOKENIZER (Loop-based, replacing regex split) ---
  tokenize(source) {
    let i = 0;
    const length = source.length;
    this.tokens = [];

    while (i < length) {
      let char = source[i];

      // Skip Whitespace
      if (/\s/.test(char)) {
        i++;
        continue;
      }

      // Comments (// or #)
      if (char === "#" || (char === "/" && source[i + 1] === "/")) {
        while (i < length && source[i] !== "\n") i++;
        continue;
      }

      // Operators & Delimiters
      if ("=+-*/(),.;[]!".includes(char)) {
        // Check for compound operators +=, -=, etc.
        if ("+-*/".includes(char) && source[i + 1] === "=") {
          this.tokens.push({ type: TokenType.OPERATOR, value: char + "=" });
          i += 2;
        } else if (char === "!" && source[i + 1] === "!") {
          this.tokens.push({ type: TokenType.DELIMITER, value: "!!" });
          i += 2;
        } else {
          let type = "=+-*/".includes(char)
            ? TokenType.OPERATOR
            : TokenType.DELIMITER;
          this.tokens.push({ type: type, value: char });
          i++;
        }
        continue;
      }

      // Strings "text"
      if (char === '"') {
        let start = ++i;
        while (i < length && source[i] !== '"') i++;
        let val = source.slice(start, i);
        i++; // skip closing quote
        // Logic: Is it a char "D" or string "Hello"?
        if (val.length === 1) {
          this.tokens.push({ type: TokenType.CHAR_LITERAL, value: val });
        } else {
          this.tokens.push({ type: TokenType.STRING_LITERAL, value: val });
        }
        continue;
      }
      // Single quotes 'D'
      if (char === "'") {
        let start = ++i;
        while (i < length && source[i] !== "'") i++;
        let val = source.slice(start, i);
        i++;
        this.tokens.push({ type: TokenType.CHAR_LITERAL, value: val });
        continue;
      }

      // Identifiers & Keywords
      if (/[a-zA-Z_]/.test(char)) {
        let start = i;
        while (i < length && /[a-zA-Z0-9_]/.test(source[i])) i++;
        let val = source.slice(start, i);

        // Handle "var.int" logic (your flexible requirement)
        // If previous token was 'var' or 'const' and current is 'int', we treat as keyword sequence

        if (
          KEYWORDS.includes(val) ||
          val === "int" ||
          val === "float" ||
          val === "char"
        ) {
          this.tokens.push({ type: TokenType.KEYWORD, value: val });
        } else {
          this.tokens.push({ type: TokenType.VARIABLE, value: val });
        }
        continue;
      }

      // Numbers
      if (/[0-9]/.test(char)) {
        let start = i;
        while (i < length && /[0-9]/.test(source[i])) i++;
        let val = source.slice(start, i);
        this.tokens.push({ type: TokenType.INTEGER, value: val });
        continue;
      }

      i++; // Skip unknown
    }
  }

  // --- 3.4: RECURSIVE DESCENT PARSER (Structure from C) ---

  // Helpers to consume tokens
  match(type, value) {
    if (this.pos < this.tokens.length) {
      let t = this.tokens[this.pos];
      if (t.type === type && (!value || t.value === value)) {
        this.pos++;
        return t;
      }
    }
    return null;
  }

  peek() {
    return this.tokens[this.pos];
  }

  // Main Entry Point
  parse() {
    while (this.pos < this.tokens.length) {
      let t = this.peek();

      if (t.value === "boot") {
        this.pos++;
        continue;
      }
      if (t.value === "end") {
        this.pos++;
        continue;
      }

      if (t.value === "var" || t.value === "const") {
        this.parseDeclaration();
      } else if (t.type === TokenType.VARIABLE) {
        this.parseAssignment();
      } else if (t.value === "dsply" || t.value === "dsply@") {
        this.parsePrint();
      } else {
        this.pos++; // Skip unknown/delimiters
      }
    }
  }

  parseDeclaration() {
    // Format: var . type name = val
    this.resetTempRegs();
    let scope = this.tokens[this.pos++].value; // var or const

    // Skip dots/spaces until type
    while (this.peek().value === ".") this.pos++;

    let typeToken = this.match(TokenType.KEYWORD); // int/float/char
    if (!typeToken) throw new Error("Expected type after declaration");
    let type = typeToken.value;

    let nameToken = this.match(TokenType.VARIABLE);
    if (!nameToken) throw new Error("Expected variable name");
    let name = nameToken.value;

    // Add to Symbol Table
    let isConst = scope === "const";
    this.addSymbol(name, type, isConst);

    // Check for Assignment
    if (this.match(TokenType.OPERATOR, "=")) {
      // Parse the RHS expression
      let reg = this.parseExpression();

      // Generate Store Instruction
      if (type === "char") {
        // SB (Store Byte)
        let regNum = parseInt(reg.substring(1));
        this.emitInstruction(
          "SB",
          0,
          regNum,
          0,
          0,
          `SB ${reg}, ${name}(R0)`,
          `init ${name}`
        );
      } else {
        // SD (Store Double)
        let regNum = parseInt(reg.substring(1));
        this.emitInstruction(
          "SD",
          0,
          regNum,
          0,
          0,
          `SD ${reg}, ${name}(R0)`,
          `init ${name}`
        );
      }
    }
  }

  parseAssignment() {
    this.resetTempRegs();
    let nameToken = this.match(TokenType.VARIABLE);
    let name = nameToken.value;
    let sym = this.findSymbol(name);

    if (!sym) throw new Error(`Undefined variable '${name}'`);
    if (sym.isConst) throw new Error(`Cannot reassign constant '${name}'`);

    let opToken = this.match(TokenType.OPERATOR);
    if (!opToken) return; // Weird state

    let op = opToken.value; // =, +=, -= ...

    if (op === "=") {
      let reg = this.parseExpression();
      let regNum = parseInt(reg.substring(1));

      if (sym.type === "char") {
        this.emitInstruction(
          "SB",
          0,
          regNum,
          0,
          0,
          `SB ${reg}, ${name}(R0)`,
          `assign ${name}`
        );
      } else {
        this.emitInstruction(
          "SD",
          0,
          regNum,
          0,
          0,
          `SD ${reg}, ${name}(R0)`,
          `assign ${name}`
        );
      }
    } else {
      // Compound (+=, etc) logic: Load, Op, Store
      // 1. Load current val
      let loadReg = this.getTempReg();
      let loadRegNum = parseInt(loadReg.substring(1));
      if (sym.type === "char") {
        this.emitInstruction(
          "LBU",
          loadRegNum,
          0,
          0,
          0,
          `LBU ${loadReg}, ${name}(R0)`,
          `load for ${op}`
        );
      } else {
        this.emitInstruction(
          "LD",
          loadRegNum,
          0,
          0,
          0,
          `LD ${loadReg}, ${name}(R0)`,
          `load for ${op}`
        );
      }

      // 2. Parse RHS
      let rhsReg = this.parseExpression();
      let rhsRegNum = parseInt(rhsReg.substring(1));

      // 3. Perform Op
      let resReg = this.getTempReg();
      let resRegNum = parseInt(resReg.substring(1));

      let mathOp = op.charAt(0); // + from +=
      if (mathOp === "+")
        this.emitInstruction(
          "DADDU",
          resRegNum,
          loadRegNum,
          rhsRegNum,
          0,
          `DADDU ${resReg}, ${loadReg}, ${rhsReg}`,
          "add assign"
        );
      else if (mathOp === "-")
        this.emitInstruction(
          "DSUBU",
          resRegNum,
          loadRegNum,
          rhsRegNum,
          0,
          `DSUBU ${resReg}, ${loadReg}, ${rhsReg}`,
          "sub assign"
        );
      else if (mathOp === "*") {
        this.emitInstruction(
          "DMULTU",
          0,
          loadRegNum,
          rhsRegNum,
          0,
          `DMULTU ${loadReg}, ${rhsReg}`,
          "mult assign"
        );
        this.emitInstruction(
          "MFLO",
          resRegNum,
          0,
          0,
          0,
          `MFLO ${resReg}`,
          "result"
        );
      } else if (mathOp === "/") {
        this.emitInstruction(
          "DDIVU",
          0,
          loadRegNum,
          rhsRegNum,
          0,
          `DDIVU ${loadReg}, ${rhsReg}`,
          "div assign"
        );
        this.emitInstruction(
          "MFLO",
          resRegNum,
          0,
          0,
          0,
          `MFLO ${resReg}`,
          "result"
        );
      }

      // 4. Store Back
      if (sym.type === "char") {
        this.emitInstruction(
          "SB",
          0,
          resRegNum,
          0,
          0,
          `SB ${resReg}, ${name}(R0)`,
          `store result`
        );
      } else {
        this.emitInstruction(
          "SD",
          0,
          resRegNum,
          0,
          0,
          `SD ${resReg}, ${name}(R0)`,
          `store result`
        );
      }
    }
  }

  parsePrint() {
    this.resetTempRegs();
    let cmd = this.tokens[this.pos++].value; // dsply or dsply@

    if (this.match(TokenType.DELIMITER, "[")) {
      // Check content
      let t = this.peek();
      if (t.type === TokenType.STRING_LITERAL) {
        // String print - Silent in ASM
        this.pos++;
      } else {
        if (cmd === "dsply")
          throw new Error("Use 'dsply@' to print variables/expressions");

        // Parse Expression
        let reg = this.parseExpression();
        // Silent in ASM for simple var, but complex expr generated instructions above
      }
      this.match(TokenType.DELIMITER, "]");
    }
    // Skip !! or !
    while (
      this.match(TokenType.DELIMITER, "!") ||
      this.match(TokenType.DELIMITER, "!!")
    );
  }

  // --- RECURSIVE DESCENT MATH PARSER ---
  // Expression -> Term { + Term }
  parseExpression() {
    let leftReg = this.parseTerm();

    while (this.pos < this.tokens.length) {
      let t = this.peek();
      if (t.value !== "+" && t.value !== "-") break;

      let op = t.value;
      this.pos++;

      let rightReg = this.parseTerm();
      let resReg = this.getTempReg();

      let r1 = parseInt(leftReg.substring(1));
      let r2 = parseInt(rightReg.substring(1));
      let r3 = parseInt(resReg.substring(1));

      if (op === "+") {
        this.emitInstruction(
          "DADDU",
          r3,
          r1,
          r2,
          0,
          `DADDU ${resReg}, ${leftReg}, ${rightReg}`,
          "add"
        );
      } else {
        this.emitInstruction(
          "DSUBU",
          r3,
          r1,
          r2,
          0,
          `DSUBU ${resReg}, ${leftReg}, ${rightReg}`,
          "sub"
        );
      }
      leftReg = resReg;
    }
    return leftReg;
  }

  // Term -> Factor { * Factor }
  parseTerm() {
    let leftReg = this.parseFactor();

    while (this.pos < this.tokens.length) {
      let t = this.peek();
      if (t.value !== "*" && t.value !== "/") break;

      let op = t.value;
      this.pos++;

      let rightReg = this.parseFactor();
      let resReg = this.getTempReg();

      let r1 = parseInt(leftReg.substring(1));
      let r2 = parseInt(rightReg.substring(1));
      let r3 = parseInt(resReg.substring(1));

      if (op === "*") {
        this.emitInstruction(
          "DMULTU",
          0,
          r1,
          r2,
          0,
          `DMULTU ${leftReg}, ${rightReg}`,
          "mult"
        );
        this.emitInstruction("MFLO", r3, 0, 0, 0, `MFLO ${resReg}`, "result");
      } else {
        this.emitInstruction(
          "DDIVU",
          0,
          r1,
          r2,
          0,
          `DDIVU ${leftReg}, ${rightReg}`,
          "div"
        );
        this.emitInstruction("MFLO", r3, 0, 0, 0, `MFLO ${resReg}`, "result");
      }
      leftReg = resReg;
    }
    return leftReg;
  }

  // Factor -> Int | Var | (Expr)
  parseFactor() {
    let t = this.peek();
    let reg = this.getTempReg();
    let regNum = parseInt(reg.substring(1));

    if (t.type === TokenType.INTEGER) {
      let val = parseInt(t.value);
      this.emitInstruction(
        "DADDIU",
        0,
        0,
        regNum,
        val,
        `DADDIU ${reg}, R0, #${val}`,
        "load imm"
      );
      this.pos++;
      return reg;
    } else if (t.type === TokenType.CHAR_LITERAL) {
      let val = t.value.charCodeAt(0);
      this.emitInstruction(
        "DADDIU",
        0,
        0,
        regNum,
        val,
        `DADDIU ${reg}, R0, #${val}`,
        "load char"
      );
      this.pos++;
      return reg;
    } else if (t.type === TokenType.VARIABLE) {
      let sym = this.findSymbol(t.value);
      if (!sym) throw new Error(`Undefined variable '${t.value}'`);

      if (sym.type === "char") {
        this.emitInstruction(
          "LBU",
          regNum,
          0,
          0,
          0,
          `LBU ${reg}, ${t.value}(R0)`,
          "load var"
        );
      } else {
        this.emitInstruction(
          "LD",
          regNum,
          0,
          0,
          0,
          `LD ${reg}, ${t.value}(R0)`,
          "load var"
        );
      }
      this.pos++;
      return reg;
    } else if (t.value === "(") {
      this.pos++;
      let r = this.parseExpression();
      this.match(TokenType.DELIMITER, ")");
      return r;
    }
    throw new Error(`Unexpected token '${t.value}'`);
  }
}

// =============================================================
//  PART 4: EXPRESS API
// =============================================================
app.post("/compile", (req, res) => {
  const code = req.body.code;
  const tempFile = path.join(__dirname, "temp_code.txt");

  // 1. Run JS Simulator (Generate ASM/Hex)
  let mips = "",
    binary = "";
  try {
    const simulator = new CompilerSimulator();
    simulator.tokenize(code);
    simulator.parse();
    mips = simulator.dataSection + simulator.codeSection;
    binary = simulator.binaryOutput;
  } catch (err) {
    // FAIL FAST
    return res.json({
      output: `Transpiler Error: ${err.message}`,
      mips: "",
      binary: "",
    });
  }

  // 2. Run Real C Compiler (edoc)
  fs.writeFileSync(tempFile, code);
  exec(`${COMPILER_PATH} < ${tempFile}`, (error, stdout, stderr) => {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

    let finalOutput = stdout;
    if (stderr) finalOutput += `\n--- Errors ---\n${stderr}`;
    if (error) finalOutput += `\n--- System Error ---\n${error.message}`;

    res.json({
      output: finalOutput || "No Output",
      mips: mips,
      binary: binary,
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
