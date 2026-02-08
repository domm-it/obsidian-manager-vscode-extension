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
    console.log('=== Checkbox mark request received ===');
    console.log('Query params:', req.query);
    
    if (!validateNonce(req.query.nonce as string, serverNonce)) {
        console.error('Invalid nonce!');
        res.status(403).send('Forbidden');
        return;
    }

    const source = req.query.source as string;
    const line = parseInt(req.query.line as string);
    const checked = req.query.checked === 'true';

    console.log('Processing checkbox:', { source, line, checked });

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
        console.log('markCheckbox called with:', { source, line, checked });
        
        const uri = vscode.Uri.parse(source);
        console.log('Parsed URI:', uri.toString());
        console.log('URI scheme:', uri.scheme, 'fsPath:', uri.fsPath);
        
        const document = await vscode.workspace.openTextDocument(uri);
        console.log('Document opened, line count:', document.lineCount);

        if (line < 0 || line >= document.lineCount) {
            console.error(`Line ${line} is out of bounds (document has ${document.lineCount} lines)`);
            return;
        }

        const lineText = document.lineAt(line).text;
        console.log(`Line ${line} text: "${lineText}"`);
        
        const checkboxMatch = lineText.match(/\[([ xX])\]/);
        const checkboxColumn = checkboxMatch?.index;

        if (checkboxColumn === undefined || !checkboxMatch) {
            console.error(`Checkbox not found at line ${line}! Line text: "${lineText}"`);
            // Try to find checkbox in nearby lines
            for (let i = Math.max(0, line - 2); i < Math.min(document.lineCount, line + 3); i++) {
                const nearbyText = document.lineAt(i).text;
                if (nearbyText.match(/\[([ xX])\]/)) {
                    console.log(`Found checkbox at line ${i}: "${nearbyText}"`);
                }
            }
            return;
        }

        console.log(`Found checkbox at column ${checkboxColumn}, current state: "${checkboxMatch[1]}", changing to: ${checked ? 'x' : ' '}`);

        // Position is inside the brackets: [x] -> position of 'x' or ' '
        const checkRange = new vscode.Range(
            line,
            checkboxColumn + 1, // +1 to skip the '['
            line,
            checkboxColumn + 2  // +2 to select only the checkbox character
        );
        
        const newMark = checked ? 'x' : ' ';
        console.log('Creating edit for range:', checkRange, 'replacing with:', newMark);

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, checkRange, newMark);
        
        const success = await vscode.workspace.applyEdit(edit);
        console.log('Edit applied:', success);
        
        if (success) {
            // Wait a bit for the edit to be applied
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // Save the document
            const saved = await document.save();
            console.log('Document saved:', saved);
            
            if (!saved) {
                console.error('Failed to save document');
            } else {
                console.log('✓ Checkbox successfully updated and saved!');
            }
        } else {
            console.error('Failed to apply edit');
        }
    } catch (error) {
        console.error('Error marking checkbox:', error);
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
    }
}
