'use strict';

// https://github.github.com/gfm/#tables-extension-

import * as vscode from "vscode";
import { configManager } from "./configuration/manager";
import { Document_Selector_Markdown } from "./util/generic";
//// This module can only be referenced with ECMAScript imports/exports by turning on the 'esModuleInterop' flag and referencing its default export.
// import { GraphemeSplitter } from 'grapheme-splitter';
import GraphemeSplitter = require('grapheme-splitter');

const splitter = new GraphemeSplitter();

interface ITableRange {
    text: string;
    offset: number;
    range: vscode.Range;
}

// Dedicated objects for managing the formatter.
const d0 = Object.freeze<vscode.Disposable & { _disposables: vscode.Disposable[] }>({
    _disposables: [],
    dispose: function () {
        for (const item of this._disposables) {
            item.dispose();
        }
        this._disposables.length = 0;
    },
});

const registerFormatter = () => {
    if (configManager.get("tableFormatter.enabled")) {
        d0._disposables.push(vscode.languages.registerDocumentFormattingEditProvider(Document_Selector_Markdown, new MarkdownDocumentFormatter()));
        d0._disposables.push(vscode.languages.registerDocumentRangeFormattingEditProvider(Document_Selector_Markdown, new MarkdownDocumentRangeFormattingEditProvider()));
    } else {
        d0.dispose();
    }
}

export function activate(context: vscode.ExtensionContext) {
    const d1 = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("markdown.extension.tableFormatter.enabled")) {
            registerFormatter();
        }
    });

    registerFormatter();

    context.subscriptions.push(d1, d0);
}

enum ColumnAlignment {
    None,
    Left,
    Center,
    Right
}

class MarkdownDocumentFormatter implements vscode.DocumentFormattingEditProvider {
    provideDocumentFormattingEdits(document: vscode.TextDocument, options: vscode.FormattingOptions, token: vscode.CancellationToken) {
        const tables = this.detectTables(document);
        if (!tables || token.isCancellationRequested) {
            return;
        }

        const edits: vscode.TextEdit[] = tables.map(
            (target) => new vscode.TextEdit(target.range, this.formatTable(target, document, options))
        );

        return edits;
    }

    protected detectTables(document: vscode.TextDocument): ITableRange[] | undefined {
        const text = document.getText();

        const lineBreak = String.raw`\r?\n`;
        const contentLine = String.raw`\|?.*\|.*\|?`;

        const leftSideHyphenComponent = String.raw`(?:\|? *:?-+:? *\|)`;
        const middleHyphenComponent = String.raw`(?: *:?-+:? *\|)*`;
        const rightSideHyphenComponent = String.raw`(?: *:?-+:? *\|?)`;
        const multiColumnHyphenLine = leftSideHyphenComponent + middleHyphenComponent + rightSideHyphenComponent;

        //// GitHub issue #431
        const singleColumnHyphenLine = String.raw`(?:\| *:?-+:? *\|)`;

        const hyphenLine = String.raw`[ \t]*(?:${multiColumnHyphenLine}|${singleColumnHyphenLine})[ \t]*`;

        const tableRegex = new RegExp(contentLine + lineBreak + hyphenLine + '(?:' + lineBreak + contentLine + ')*', 'g');

        const result: ITableRange[] = Array.from(
            text.matchAll(tableRegex),
            (item): ITableRange => ({
                text: item[0],
                offset: item.index!,
                range: new vscode.Range(
                    document.positionAt(item.index!),
                    document.positionAt(item.index! + item[0].length)
                ),
            })
        );

        return result.length ? result : undefined;
    }

    /**
     * Return the indentation of a table as a string of spaces by reading it from the first line.
     * In case of `markdown.extension.table.normalizeIndentation` is `enabled` it is rounded to the closest multiple of
     * the configured `tabSize`.
     */
    private getTableIndentation(text: string, options: vscode.FormattingOptions) {
        let doNormalize = configManager.get("tableFormatter.normalizeIndentation");
        let indentRegex = new RegExp(/^(\s*)\S/u);
        let match = text.match(indentRegex);
        let spacesInFirstLine = match?.[1].length ?? 0;
        let tabStops = Math.round(spacesInFirstLine / options.tabSize);
        let spaces = doNormalize ? " ".repeat(options.tabSize * tabStops) : " ".repeat(spacesInFirstLine);
        return spaces;
    }

    protected formatTable(target: ITableRange, doc: vscode.TextDocument, options: vscode.FormattingOptions) {
        // The following operations require the Unicode Normalization Form C (NFC).
        const text = target.text.normalize();

        const headerRowIndex = 0;
        const delimiterRowIndex = 1;
        const delimiterRowNoPadding = configManager.get('tableFormatter.delimiterRowNoPadding');
        const compact = configManager.get('tableFormatter.compact');
        // The shortest delimiter cell this formatter writes, counted in hyphens; each column alignment
        // specification adds its own colons on top of that. Guarded because a delimiter cell with no hyphen
        // at all is not a table any more.
        const minHyphens = Math.max(1, Math.trunc(configManager.get('tableFormatter.delimiterRowMinHyphens')));
        const indentation = this.getTableIndentation(text, options);

        const rowsNoIndentPattern = new RegExp(/^\s*(\S.*)$/gum);
        const rows: string[] = Array.from(text.matchAll(rowsNoIndentPattern), (match) => match[1].trim());

        // Desired "visual" width of each column (the length of the longest cell in each column), **without padding**
        const colWidth: number[] = [];
        // "Visual" width of each header cell, **without padding**
        const headerWidth: number[] = [];
        // Alignment of each column
        const colAlign: ColumnAlignment[] = [];
        // Regex to extract cell content.
        // GitHub #24
        const fieldRegExp = new RegExp(/((\\\||[^\|])*)\|/gu);
        // Emoji and CJK characters with double visual width (width 2)
        // https://www.ling.upenn.edu/courses/Spring_2003/ling538/UnicodeRanges.html
        // Extended_Pictographic includes all graphical emoji chars
        // CJK ranges: U+3000-U+9FFF, U+AC00-U+D7AF, U+FF01-U+FF60
        const doubleWidthRegex = /\p{Extended_Pictographic}|[\u3000-\u9fff\uac00-\ud7af\uff01-\uff60]/gu;

        const lines = rows.map((row, iRow) => {
            // Normalize
            if (row.startsWith('|')) {
                row = row.slice(1);
            }
            if (!row.endsWith('|')) {
                row = row + '|';
            }

            // Parse cells in the current row
            let values = [];
            let iCol = 0;
            for (const field of row.matchAll(fieldRegExp)) {
                let cell = field[1].trim();
                values.push(cell);

                // Ignore the length of delimiter-line before we normalize it
                if (iRow === delimiterRowIndex) {
                    continue;
                }

                // Calculate the desired "visual" column width.
                // The following notes help to understand the precondition for our calculation.
                // They don't reflect how text layout engines really work.
                // For more information, please consult UAX #11.
                // A grapheme cluster may comprise multiple Unicode code points.
                // In typical fixed-width typesetting without ligature, one grapheme is finally mapped to one glyph.
                // Such a glyph is usually the same width as an ASCII letter.
                // However, emoji symbols and CJK characters have double width in most fonts.
                // We add the count of double-width characters to the grapheme count to get visual width.

                const graphemeCount = splitter.countGraphemes(cell);
                const doubleWidthChars = cell.match(doubleWidthRegex);
                const width = graphemeCount + (doubleWidthChars?.length ?? 0);
                colWidth[iCol] = Math.max(colWidth[iCol] || 0, width);
                if (iRow === headerRowIndex) {
                    headerWidth[iCol] = width;
                }

                iCol++;
            }
            return values;
        });

        // Width the delimiter row is normalized to. Without padding there is nothing to align the cells
        // with, so the delimiter row follows the header cell instead of the widest cell in the column.
        // That also keeps an edit to a data row from rewriting the delimiter row.
        // Each branch below clamps that width to `minHyphens` plus the colons its column alignment
        // specification needs, so the default of 3 keeps the conventional `---`, `:---`, `---:` and `:---:`
        // forms while a lower setting lets the delimiter row line up with a very short header.
        const delimiterWidth: number[] = compact ? headerWidth : colWidth;

        // Normalize the num of hyphen according to the desired column length
        lines[delimiterRowIndex] = lines[delimiterRowIndex].map((cell, iCol) => {
            if (/:-+:/.test(cell)) {
                // :---:
                colAlign[iCol] = ColumnAlignment.Center;
                // Update the lower bound of the visual delimiter width (without padding) based on the column alignment specification
                const minWidth = minHyphens + 2;
                delimiterWidth[iCol] = Math.max(delimiterWidth[iCol] ?? 0, delimiterRowNoPadding ? minWidth - 2 : minWidth);
                // The length of all `-`, `:` chars in this delimiter cell
                const specWidth = delimiterRowNoPadding ? delimiterWidth[iCol] + 2 : delimiterWidth[iCol];
                return ':' + '-'.repeat(specWidth - 2) + ':';
            } else if (/:-+/.test(cell)) {
                // :---
                colAlign[iCol] = ColumnAlignment.Left;
                const minWidth = minHyphens + 1;
                delimiterWidth[iCol] = Math.max(delimiterWidth[iCol] ?? 0, delimiterRowNoPadding ? minWidth - 2 : minWidth);
                const specWidth = delimiterRowNoPadding ? delimiterWidth[iCol] + 2 : delimiterWidth[iCol];
                return ':' + '-'.repeat(specWidth - 1);
            } else if (/-+:/.test(cell)) {
                // ---:
                colAlign[iCol] = ColumnAlignment.Right;
                const minWidth = minHyphens + 1;
                delimiterWidth[iCol] = Math.max(delimiterWidth[iCol] ?? 0, delimiterRowNoPadding ? minWidth - 2 : minWidth);
                const specWidth = delimiterRowNoPadding ? delimiterWidth[iCol] + 2 : delimiterWidth[iCol];
                return '-'.repeat(specWidth - 1) + ':';
            } else {
                // ---
                colAlign[iCol] = ColumnAlignment.None;
                const minWidth = minHyphens;
                delimiterWidth[iCol] = Math.max(delimiterWidth[iCol] ?? 0, delimiterRowNoPadding ? minWidth - 2 : minWidth);
                const specWidth = delimiterRowNoPadding ? delimiterWidth[iCol] + 2 : delimiterWidth[iCol];
                return '-'.repeat(specWidth);
            }
        });

        return lines.map((row, iRow) => {
            if (iRow === delimiterRowIndex && delimiterRowNoPadding) {
                return indentation + '|' + row.join('|') + '|';
            }

            // Cells are already trimmed, so there is nothing left to do but join them
            if (compact) {
                return indentation + '| ' + row.join(' | ') + ' |';
            }

            let cells = row.map((cell, iCol) => {
                const visualWidth = colWidth[iCol];
                let jsLength = splitter.splitGraphemes(cell + ' '.repeat(visualWidth)).slice(0, visualWidth).join('').length;

                // Subtract double-width characters (emoji and CJK)
                jsLength -= cell.match(doubleWidthRegex)?.length ?? 0;

                return this.alignText(cell, colAlign[iCol], jsLength);
            });
            return indentation + '| ' + cells.join(' | ') + ' |';
        }).join(doc.eol === vscode.EndOfLine.LF ? '\n' : '\r\n');
    }

    private alignText(text: string, align: ColumnAlignment, length: number) {
        if (align === ColumnAlignment.Center && length > text.length) {
            return (' '.repeat(Math.floor((length - text.length) / 2)) + text + ' '.repeat(length)).slice(0, length);
        } else if (align === ColumnAlignment.Right) {
            return (' '.repeat(length) + text).slice(-length);
        } else {
            return (text + ' '.repeat(length)).slice(0, length);
        }
    }
}

class MarkdownDocumentRangeFormattingEditProvider extends MarkdownDocumentFormatter implements vscode.DocumentRangeFormattingEditProvider {
    provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range, options: vscode.FormattingOptions, token: vscode.CancellationToken) {
        const tables = this.detectTables(document);
        if (!tables || token.isCancellationRequested) {
            return;
        }

        const selectedTables = new Array();
        tables.forEach((table) => {
            if (range.contains(table.range)) {
                selectedTables.push(table);
            }
        });

        const edits: vscode.TextEdit[] = selectedTables.map((target) => {
            return new vscode.TextEdit(
                target.range,
                this.formatTable(target, document, options)
            );
        });

        return edits;
    }
}