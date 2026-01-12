%option noyywrap

%{
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "parser.tab.h"

void yyerror(const char *s);
%}

%%

"boot"      { return BOOT; }
"end"       { return END; }
"dsply@"    { return DSPLY_AT; } /* Re-introduced for Variables */
"dsply"     { return DSPLY; }    /* strictly for Strings */
"var"       { return VAR; }
"const"     { return CONST; }
"int"       { return TYPE_INT; }
"float"     { return TYPE_FLOAT; }
"char"      { return TYPE_CHAR; }

"!!"        { return DBL_BANG; }
"!"         { return BANG; }
"."         { return DOT; }
","         { return COMMA; }
"["         { return LBRACKET; }
"]"         { return RBRACKET; }
"("         { return LPAREN; }
")"         { return RPAREN; }

"+="        { return ADD_ASSIGN; }
"-="        { return SUB_ASSIGN; }
"*="        { return MUL_ASSIGN; }
"/="        { return DIV_ASSIGN; }
"="         { return ASSIGN; }
"+"         { return PLUS; }
"-"         { return MINUS; }
"*"         { return MULT; }
"/"         { return DIV; }

\"[^"\n]*\" {
    yylval.strVal = strdup(yytext);
    return STRING_LITERAL;
}

[0-9]+\.[0-9]+ { yylval.fVal = atof(yytext); return NUMBER_FLOAT; }
[0-9]+         { yylval.iVal = atoi(yytext); return NUMBER_INT; }

[a-zA-Z][a-zA-Z0-9_]* {
    yylval.strVal = strdup(yytext);
    return IDENT;
}

#.* { /* Ignore comments */ }

[ \t\r\n]   { /* Ignore whitespace */ }

.           { printf("Unknown character: %s\n", yytext); }

%%