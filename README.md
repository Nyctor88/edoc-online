# EDOC Studio — Web-Based Custom Language Compiler

**EDOC** is a custom programming language designed for educational purposes, focusing on strict typing and C-like syntax. **EDOC Studio** is the accompanying web-based IDE that allows users to write, execute, and inspect the assembly translation of EDOC programs directly in the browser.

[**🚀 Try the Live Demo**](https://edoc-online.onrender.com/)

---

## ✨ Key Features

### 🖥️ The Language (EDOC)
* **Strict Typing:** Supports `int`, `float`, and `char` data types.
* **Safety First:** Includes `const` declarations for immutable variables.
* **Arithmetic Power:** Handles complex order of operations (PEMDAS).
* **Built-in I/O:** `dsply` for strings and `dsply@` for variables and expressions.

### 🛠️ The IDE (Web Studio)
* **Dual-Engine Compilation:** * **Execution Engine:** Runs the actual code using a C-based interpreter (Flex/Bison) running on the server.
    * **Translation Engine:** A JavaScript-based Shunting-Yard parser that generates valid **eduMIPS64** assembly code.
* **Split-Screen Interface:** Modern code editor on the left; Output, Assembly, and Binary views on the right.
* **Responsive Design:** Fully functional on mobile devices with stacked layouts.

---

## 📖 Syntax Guide

### 1. Basic Structure
Every EDOC program must be enclosed in `boot` and `end`.
```text
boot
    // Your code goes here
end 
```
### 2. Variables & Constants
Use var. for variables and const. for constants. Notice the dot . syntax.
```
var. int score = 100
var. float pi = 3.14
const. int MAX_LIVES = 3
var. char grade = "A"
```
### 3. Printing
Use `dsply` for strings and `dsply@` for variables/math.
`!` = Single Newline
`!!` = Double Newline
```
dsply ["Hello World"]!
dsply ["Value is: "]
dsply@[x * 2]!!
```
### 4. Math
Standard arithmetic is supported with precedence rules.
```
total = a + b * (c - 5)
```

---

## 🔧 Local Installation
If you want to run this project on your own machine:

### Prerequisites
* **C Compiler: GCC, Flex, Bison (or WinFlexBison for Windows).
* **Node.js: Installed globally.

### Steps
### 1. Clone the Repository
```
git clone [https://github.com/Nyctor88/edoc-online.git](https://github.com/Nyctor88/edoc-online.git)
cd edoc-online
```
### 2. Compile the Interpreter
```
flex lexer.l
bison -d parser.y
gcc lex.yy.c parser.tab.c -o edoc
```
### 3. Start the Server
```
npm install
node server.js
```
### 4. Open in Browser Visit `http://localhost:3000`

---

# 📂 Project Structure
```
/
├── Dockerfile          # Cloud deployment config
├── server.js           # Node.js backend & MIPS Transpiler
├── parser.y            # Bison Grammar Rules (The Brains)
├── lexer.l             # Flex Tokenizer (The Eyes)
├── package.json        # Node dependencies
└── public/             # Frontend Assets
    └── index.html      # The Web IDE UI
```

---

# 👨‍💻 Author
David Cinco and Niño Piedad
BS Computer Science Student Built for the CSC 112 Final Project.
