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
//  PART 1: CONSTANTS & TOKEN DEFINITIONS
// =============================================================
const TokenType = {
  KEYWORD: "KEYWORD",
  VARIABLE: "VARIABLE",
  INTEGER: "INTEGER",
  CHAR_LITERAL: "CHAR_LITERAL",
  OPERATOR: "OPERATOR",
  DELIMITER: "DELIMITER",
  STRING_LITERAL: "STRING_LITERAL",
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
// =============================================================
class CompilerSimulator {
  constructor() {
    this.tokens = [];
    this.pos = 0;
    this.symbolTable = [];
    this.currentAddr = 0;
    this.dataSection = ".data\n";
    this.codeSection = ".code\n";
    this.binaryOutput = "";
    this.tempRegCount = 0;
  }

  // --- ERROR HELPER ---
  // Uses the current token's line number for accurate reporting
  error(message) {
    const token = this.peek();
    const lineStr = token ? `Line ${token.line}` : "End of File";
    throw new Error(`${lineStr}: ${message}`);
  }

  // --- SYMBOL TABLE ---
  addSymbol(name, type, isConst) {
    if (this.findSymbol(name)) {
      this.error(`Redeclaration of variable '${name}'`);
    }

    let addr = this.currentAddr;
    let size = type === "char" ? 1 : 8;

    this.symbolTable.push({ name, type, addr, isConst });

    let directive = type === "char" ? ".byte" : ".dword";
    this.dataSection += `    ${name}: ${directive}\n`;
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

  // --- MACHINE CODE WRITER ---
  emitInstruction(instr, rd, rs, rt, imm, asm_instr, comment) {
    let opcode = 0,
      funct = 0,
      machine = 0;

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
    } else if (instr === "SB") {
      opcode = 0b101000;
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff);
    } else if (instr === "LBU") {
      opcode = 0b100100;
      machine = (opcode << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff);
    }

    let binStr = toBin(machine, 32);
    let hexStr = binToHex(binStr);

    this.codeSection += `    ${asm_instr}\n`;
    this.binaryOutput += `${binStr} (${hexStr})\n`;
  }

  // --- TOKENIZER (Now Tracks Line Numbers) ---
  tokenize(source) {
    let i = 0;
    let line = 1; // Start at line 1
    const length = source.length;
    this.tokens = [];

    while (i < length) {
      let char = source[i];

      // 1. Newlines (Increment Line Count)
      if (char === "\n") {
        line++;
        i++;
        continue;
      }

      // 2. Whitespace (Skip but don't count newlines again)
      if (/\s/.test(char)) {
        i++;
        continue;
      }

      // 3. Comments
      if (char === "#" || (char === "/" && source[i + 1] === "/")) {
        while (i < length && source[i] !== "\n") i++;
        continue;
      }

      // 4. Operators & Delimiters
      if ("=+-*/(),.;[]!".includes(char)) {
        if ("+-*/".includes(char) && source[i + 1] === "=") {
          this.tokens.push({
            type: TokenType.OPERATOR,
            value: char + "=",
            line,
          });
          i += 2;
        } else if (char === "!" && source[i + 1] === "!") {
          this.tokens.push({ type: TokenType.DELIMITER, value: "!!", line });
          i += 2;
        } else {
          let type = "=+-*/".includes(char)
            ? TokenType.OPERATOR
            : TokenType.DELIMITER;
          this.tokens.push({ type: type, value: char, line });
          i++;
        }
        continue;
      }

      // 5. String Literals
      if (char === '"') {
        let start = ++i;
        while (i < length && source[i] !== '"') i++;
        let val = source.slice(start, i);
        i++;
        if (val.length === 1) {
          this.tokens.push({ type: TokenType.CHAR_LITERAL, value: val, line });
        } else {
          this.tokens.push({
            type: TokenType.STRING_LITERAL,
            value: val,
            line,
          });
        }
        continue;
      }

      // 6. Single Quotes (Fail Fast)
      if (char === "'") {
        throw new Error(
          `Line ${line}: Single quotes are not supported. Use double quotes (") for characters.`
        );
      }

      // 7. Identifiers & Keywords (Supports @)
      if (/[a-zA-Z_]/.test(char)) {
        let start = i;
        while (i < length && /[a-zA-Z0-9_@]/.test(source[i])) i++;
        let val = source.slice(start, i);

        if (
          KEYWORDS.includes(val) ||
          val === "int" ||
          val === "float" ||
          val === "char"
        ) {
          this.tokens.push({ type: TokenType.KEYWORD, value: val, line });
        } else {
          this.tokens.push({ type: TokenType.VARIABLE, value: val, line });
        }
        continue;
      }

      // 8. Numbers
      if (/[0-9]/.test(char)) {
        let start = i;
        while (i < length && /[0-9]/.test(source[i])) i++;
        let val = source.slice(start, i);
        this.tokens.push({ type: TokenType.INTEGER, value: val, line });
        continue;
      }

      // 9. Unknown
      throw new Error(`Line ${line}: Unknown character '${char}'`);
    }
  }

  // --- PARSER ---
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
        this.error(`Unexpected token '${t.value}'`);
      }
    }
  }

  parseDeclaration() {
    this.resetTempRegs();
    let scope = this.tokens[this.pos++].value;

    while (this.peek() && this.peek().value === ".") this.pos++;

    let typeToken = this.match(TokenType.KEYWORD);
    if (!typeToken)
      this.error("Expected type (int/float/char) after declaration");
    let type = typeToken.value;

    let nameToken = this.match(TokenType.VARIABLE);
    if (!nameToken) this.error("Expected variable name");
    let name = nameToken.value;

    let isConst = scope === "const";
    this.addSymbol(name, type, isConst);

    if (this.match(TokenType.OPERATOR, "=")) {
      let reg = this.parseExpression();
      if (type === "char") {
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

    if (!sym) this.error(`Undefined variable '${name}'`);
    if (sym.isConst) this.error(`Cannot reassign constant '${name}'`);

    let opToken = this.match(TokenType.OPERATOR);
    if (!opToken) this.error(`Expected assignment operator for '${name}'`);

    let op = opToken.value;

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

      let rhsReg = this.parseExpression();
      let rhsRegNum = parseInt(rhsReg.substring(1));

      let resReg = this.getTempReg();
      let resRegNum = parseInt(resReg.substring(1));

      let mathOp = op.charAt(0);
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
    let cmdToken = this.tokens[this.pos++];
    let cmd = cmdToken.value;

    if (this.match(TokenType.DELIMITER, "[")) {
      let t = this.peek();

      if (t.type === TokenType.STRING_LITERAL) {
        this.pos++;
      } else if (
        t.type === TokenType.VARIABLE &&
        this.tokens[this.pos + 1].value === "]"
      ) {
        if (cmd === "dsply") this.error("Use 'dsply@' to print variables");
        let name = t.value;
        let sym = this.findSymbol(name);
        if (!sym) this.error(`Undefined variable '${name}'`);
        this.pos++;
      } else {
        if (cmd === "dsply")
          this.error("Use 'dsply@' to print variables/expressions");
        let reg = this.parseExpression();
      }

      if (!this.match(TokenType.DELIMITER, "]")) {
        this.error("Missing closing bracket ']'");
      }
    }
    while (
      this.match(TokenType.DELIMITER, "!") ||
      this.match(TokenType.DELIMITER, "!!")
    );
  }

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

  parseFactor() {
    let t = this.peek();
    if (!t) this.error("Unexpected end of input");

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
      if (!sym) this.error(`Undefined variable '${t.value}'`);

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
      if (!this.match(TokenType.DELIMITER, ")")) {
        this.error("Missing closing parenthesis ')'");
      }
      return r;
    }
    this.error(`Unexpected token '${t.value}'`);
  }
}

// =============================================================
//  PART 4: EXPRESS API
// =============================================================
app.post("/compile", (req, res) => {
  const code = req.body.code;
  const tempFile = path.join(__dirname, "temp_code.txt");

  let mips = "",
    binary = "";
  try {
    const simulator = new CompilerSimulator();
    simulator.tokenize(code);
    simulator.parse();
    mips = simulator.dataSection + simulator.codeSection;
    binary = simulator.binaryOutput;
  } catch (err) {
    return res.json({
      output: `Transpiler Error: ${err.message}`,
      mips: "",
      binary: "",
    });
  }

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
