import { randomUUID, timingSafeEqual } from 'crypto';
import express, { Request, Response } from 'express';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';

export function createCheckboxServer() {
    const serverNonce = randomUUID().toString();

    const app = express();
    app.disable('view cache');
    
    app.get('/checkbox/mark', handleCheckboxMark(serverNonce));
    app.get('/hashtag/open', handleHashtagOpen(serverNonce));
    
    const server = app.listen();
    const port = (server.address() as AddressInfo).port;

    const disposable = { dispose: () => server.closeAllConnections() };

    return { port, serverNonce, disposable };
}

// Empty 1x1 transparent PNG image to return as response
const emptyImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4AWNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==';

const handleCheckboxMark = (serverNonce: string) => async (req: Request, res: Response) => {
    if (!validateNonce(req.query.nonce as string, serverNonce)) {
        res.status(403).send('Forbidden');
        return;
    }

    const source = req.query.source as string;
    const line = parseInt(req.query.line as string);
    const checked = req.query.checked === 'true';

    await markCheckbox(source, line, checked);

    res.contentType('image/png');
    res.send(Buffer.from(emptyImage, 'base64'));
};

const handleHashtagOpen = (serverNonce: string) => async (req: Request, res: Response) => {
    if (!validateNonce(req.query.nonce as string, serverNonce)) {
        res.status(403).send('Forbidden');
        return;
    }

    const hashtag = req.query.tag as string;
    
    if (hashtag) {
        await vscode.commands.executeCommand('obsidianManager.showTaskTable', undefined, undefined, hashtag);
    }

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

        // Use WorkspaceEdit to modify the file without opening an editor
        const edit = new vscode.WorkspaceEdit();
        const checkRange = new vscode.Range(
            line,
            checkboxColumn + 1,
            line,
            checkboxColumn + 2
        );
        edit.replace(uri, checkRange, newMark);
        
        // Apply the edit
        const editSuccess = await vscode.workspace.applyEdit(edit);

        if (editSuccess) {
            // Save with retry logic
            let saveAttempts = 0;
            const maxAttempts = 3;
            
            while (saveAttempts < maxAttempts) {
                try {
                    const saved = await document.save();
                    if (saved) {
                        break;
                    }
                    saveAttempts++;
                    if (saveAttempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                } catch (err) {
                    saveAttempts++;
                    if (saveAttempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                }
            }
        }
    } catch (error) {
        // Silent failure
    }
}
