import { randomUUID, timingSafeEqual } from 'crypto';
import express, { Request, Response } from 'express';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';

export function createCheckboxServer() {
    const serverNonce = randomUUID().toString();

    const app = express();
    app.disable('view cache');
    
    app.get('/checkbox/mark', handleCheckboxMark(serverNonce));
    
    const server = app.listen();
    const port = (server.address() as AddressInfo).port;

    const disposable = { dispose: () => server.closeAllConnections() };

    return { port, serverNonce, disposable };
}

// Empty 1x1 transparent PNG image to return as response
const emptyImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4AWNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==';

const handleCheckboxMark = (serverNonce: string) => (req: Request, res: Response) => {
    if (!validateNonce(req.query.nonce as string, serverNonce)) {
        res.status(403).send('Forbidden');
        return;
    }

    const source = req.query.source as string;
    const line = parseInt(req.query.line as string);
    const checked = req.query.checked === 'true';

    markCheckbox(source, line, checked);

    res.contentType('image/png');
    res.send(Buffer.from(emptyImage, 'base64'));
};

function validateNonce(nonce: string, serverNonce: string) {
    if (!nonce || !serverNonce) {
        return false;
    }
    return timingSafeEqual(Buffer.from(nonce), Buffer.from(serverNonce));
}

async function markCheckbox(source: string, line: number, checked: boolean) {
    try {
        // Convert webview URL to file:// URI
        // Format: https://file+.vscode-resource.vscode-cdn.net/REAL_PATH -> file://REAL_PATH
        let filePath = source;
        if (source.includes('vscode-resource.vscode-cdn.net')) {
            const match = source.match(/vscode-resource\.vscode-cdn\.net(.+)$/);
            if (match && match[1]) {
                filePath = 'file://' + decodeURIComponent(match[1]);
            }
        }
        
        const uri = vscode.Uri.parse(filePath);
        const document = await vscode.workspace.openTextDocument(uri);

        if (line < 0 || line >= document.lineCount) {
            return;
        }

        const lineText = document.lineAt(line).text;
        const checkboxMatch = lineText.match(/\[([ xX])\]/);
        const checkboxColumn = checkboxMatch?.index;

        if (checkboxColumn === undefined || !checkboxMatch) {
            return;
        }

        const newMark = checked ? 'x' : ' ';

        // Find or open the editor for this document
        let editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
        
        if (!editor) {
            editor = await vscode.window.showTextDocument(document, { 
                preview: false, 
                preserveFocus: true,
                viewColumn: vscode.ViewColumn.Active
            });
        }

        // Use editor.edit() for more reliable editing
        const editSuccess = await editor.edit(editBuilder => {
            const checkRange = new vscode.Range(
                line,
                checkboxColumn + 1,
                line,
                checkboxColumn + 2
            );
            editBuilder.replace(checkRange, newMark);
        });

        if (editSuccess) {
            await document.save();
        }
        
    } catch (error) {
        // Silent fail
    }
}
