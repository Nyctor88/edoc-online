%{
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void yyerror(const char *s);
int yylex();

/* --- SYMBOL TABLE (Local to Parser) --- */
struct Symbol {
    char *name;
    int type;     // 0=INT, 1=FLOAT, 2=CHAR
    float val; 
    int is_const; // 1=Constant (Immutable), 0=Variable
};

struct Symbol sym_table[100];
int sym_count = 0;

/* Globals to track current declaration state */
int current_data_type = 0;
int current_is_const = 0; 

struct Symbol* find_symbol(char *name) {
    for(int i=0; i<sym_count; i++) {
        if(strcmp(sym_table[i].name, name) == 0) return &sym_table[i];
    }
    return NULL;
}

void add_symbol(char *name, int type) {
    if(find_symbol(name)) return; 
    sym_table[sym_count].name = strdup(name);
    sym_table[sym_count].type = type;
    sym_table[sym_count].val = 0;
    sym_table[sym_count].is_const = current_is_const;
    sym_count++;
}

void update_symbol(char *name, float val) {
    struct Symbol* s = find_symbol(name);
    if(s) s->val = val;
    else printf("Error: Variable %s not declared.\n", name);
}

struct Symbol* get_symbol(char *name) {
    struct Symbol* s = find_symbol(name);
    if(s) return s;
    printf("Error: Variable %s used before declaration.\n", name);
    return NULL;
}
%}

/* --- EXPOSE DATA STRUCT TO HEADER --- */
%code requires {
    typedef struct {
        float val;
        int type; // 0=INT, 1=FLOAT, 2=CHAR
    } Data;
}

%union {
    int iVal;
    float fVal;
    char *strVal;
    Data dataVal; 
}

%token BOOT END DSPLY DSPLY_AT VAR CONST
%token TYPE_INT TYPE_FLOAT TYPE_CHAR
%token DBL_BANG BANG DOT COMMA LBRACKET RBRACKET LPAREN RPAREN
%token ADD_ASSIGN SUB_ASSIGN MUL_ASSIGN DIV_ASSIGN ASSIGN
%token <strVal> IDENT STRING_LITERAL
%token <iVal> NUMBER_INT
%token <fVal> NUMBER_FLOAT

%left PLUS MINUS
%left MULT DIV

%type <iVal> newline_flag type
%type <dataVal> expression term factor

%%

program:
    BOOT statement_list END {}
    ;

statement_list:
    statement
    | statement statement_list
    ;

statement:
    print_statement
    | declaration
    | assignment
    ;

/* --- PRINT RULES --- */
print_statement:
    /* Rule 1: TEXT ONLY using "dsply" */
    DSPLY LBRACKET STRING_LITERAL RBRACKET newline_flag {
        char *s = $3;
        if(s[0] == '"') s++;
        s[strlen(s)-1] = '\0';
        printf("%s", s);
        if($5 == 1) printf("\n");
        if($5 == 2) printf("\n\n");
    }
    /* Rule 2: VARIABLES/MATH ONLY using "dsply@" */
    | DSPLY_AT LBRACKET expression RBRACKET newline_flag {
        if($3.type == 2) { 
            /* CHAR type */
            printf("%c", (int)$3.val);
        } else if ($3.type == 0) { 
            /* INT type - print with %d */
            printf("%d", (int)$3.val);
        } else {
            /* FLOAT type */
            printf("%.2f", $3.val);
        }
        
        if($5 == 1) printf("\n");
        if($5 == 2) printf("\n\n");
    }
    ;

newline_flag:
    BANG        { $$ = 1; }
    | DBL_BANG  { $$ = 2; }
    | /* empty */ { $$ = 0; }
    ;

declaration:
    VAR DOT     { current_is_const = 0; } type decl_list
    | CONST DOT { current_is_const = 1; } type decl_list
    ;

type:
    TYPE_INT      { $$ = 0; current_data_type = 0; }
    | TYPE_FLOAT  { $$ = 1; current_data_type = 1; }
    | TYPE_CHAR   { $$ = 2; current_data_type = 2; }
    ;

decl_list:
    decl_item
    | decl_item COMMA decl_list
    ;

decl_item:
    IDENT {
        add_symbol($1, current_data_type); 
    }
    | IDENT ASSIGN expression {
        add_symbol($1, current_data_type);
        update_symbol($1, $3.val);
    }
    | IDENT ASSIGN STRING_LITERAL {
        add_symbol($1, 2); 
        if(strlen($3) >= 3) update_symbol($1, (float)$3[1]);
        else update_symbol($1, 0);
    }
    ;

assignment:
    IDENT ASSIGN expression { 
        struct Symbol* s = get_symbol($1);
        if(s) {
            if(s->is_const) printf("Error: Cannot reassign constant '%s'.\n", $1);
            else update_symbol($1, $3.val);
        }
    }
    | IDENT ASSIGN STRING_LITERAL { 
        struct Symbol* s = get_symbol($1);
        if(s) {
            if(s->is_const) printf("Error: Cannot reassign constant '%s'.\n", $1);
            else {
                if(strlen($3) >= 3) update_symbol($1, (float)$3[1]); 
                else update_symbol($1, 0);
            }
        }
    }
    | IDENT ADD_ASSIGN expression { 
        struct Symbol* s = get_symbol($1);
        if(s) {
            if(s->is_const) printf("Error: Cannot reassign constant '%s'.\n", $1);
            else update_symbol($1, s->val + $3.val); 
        }
    }
    | IDENT SUB_ASSIGN expression { 
        struct Symbol* s = get_symbol($1);
        if(s) {
            if(s->is_const) printf("Error: Cannot reassign constant '%s'.\n", $1);
            else update_symbol($1, s->val - $3.val); 
        }
    }
    | IDENT MUL_ASSIGN expression { 
        struct Symbol* s = get_symbol($1);
        if(s) {
            if(s->is_const) printf("Error: Cannot reassign constant '%s'.\n", $1);
            else update_symbol($1, s->val * $3.val); 
        }
    }
    | IDENT DIV_ASSIGN expression { 
        struct Symbol* s = get_symbol($1);
        if(s) {
            if(s->is_const) printf("Error: Cannot reassign constant '%s'.\n", $1);
            else update_symbol($1, s->val / $3.val); 
        }
    }
    ;

/* --- MATH LOGIC WITH TYPE PROPAGATION --- */

expression:
    term                  { $$ = $1; }
    | expression PLUS term { 
        $$.val = $1.val + $3.val; 
        if($1.type == 1 || $3.type == 1) $$.type = 1; else $$.type = 0;
    }
    | expression MINUS term { 
        $$.val = $1.val - $3.val; 
        if($1.type == 1 || $3.type == 1) $$.type = 1; else $$.type = 0;
    }
    ;

term:
    factor                { $$ = $1; }
    | term MULT factor    { 
        $$.val = $1.val * $3.val; 
        if($1.type == 1 || $3.type == 1) $$.type = 1; else $$.type = 0;
    }
    | term DIV factor     { 
        $$.val = $1.val / $3.val; 
        if($1.type == 1 || $3.type == 1) $$.type = 1; else $$.type = 0;
    }
    ;

factor:
    NUMBER_INT            { $$.val = (float)$1; $$.type = 0; }
    | NUMBER_FLOAT        { $$.val = $1; $$.type = 1; }
    | IDENT               { 
        struct Symbol* s = get_symbol($1);
        if(s) {
            $$.val = s->val;
            $$.type = s->type; 
        } else {
            $$.val = 0; $$.type = 0;
        }
    }
    | LPAREN expression RPAREN { $$ = $2; }
    | MINUS factor        { $$.val = -$2.val; $$.type = $2.type; }
    ;

%%

void yyerror(const char *s) {
    fprintf(stderr, "Syntax Error: %s\n", s);
}

int main() {
    yyparse();
    return 0;
}