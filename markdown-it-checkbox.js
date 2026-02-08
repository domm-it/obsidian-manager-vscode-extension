// Markdown-it plugin to render checkboxes in task lists
module.exports = function(md) {
    // Store the original list item renderer
    const defaultRenderer = md.renderer.rules.list_item_open || function(tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
    };

    // Override list item rendering
    md.renderer.rules.list_item_open = function(tokens, idx, options, env, self) {
        const token = tokens[idx];
        
        // Look ahead to see if this list item starts with a checkbox pattern
        let contentToken = null;
        let textToken = null;
        
        for (let i = idx + 1; i < tokens.length; i++) {
            if (tokens[i].type === 'inline') {
                contentToken = tokens[i];
                if (contentToken.children && contentToken.children.length > 0) {
                    textToken = contentToken.children[0];
                }
                break;
            }
            if (tokens[i].type === 'list_item_close') {
                break;
            }
        }

        if (textToken && textToken.type === 'text' && textToken.content) {
            const checkboxPattern = /^\[([ xX])\]\s*/;
            const match = textToken.content.match(checkboxPattern);
            
            if (match) {
                // This is a task list item
                const isChecked = match[1].toLowerCase() === 'x';
                
                // Remove the checkbox pattern from the text content
                textToken.content = textToken.content.replace(checkboxPattern, '');
                
                // Add task-list-item class
                token.attrJoin('class', 'task-list-item');
                
                // Render the default opening tag
                let result = defaultRenderer(tokens, idx, options, env, self);
                
                // Add the checkbox HTML
                const checkboxHtml = `<input type="checkbox" class="task-list-item-checkbox" ${isChecked ? 'checked' : ''} disabled>`;
                result += checkboxHtml;
                
                return result;
            }
        }
        
        // Not a task list item, use default rendering
        return defaultRenderer(tokens, idx, options, env, self);
    };

    // Mark the parent list as a task list
    const defaultListOpen = md.renderer.rules.bullet_list_open || function(tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.bullet_list_open = function(tokens, idx, options, env, self) {
        // Check if any child list items are task items
        let hasTaskItems = false;
        for (let i = idx + 1; i < tokens.length; i++) {
            if (tokens[i].type === 'bullet_list_close') {
                break;
            }
            if (tokens[i].type === 'inline' && tokens[i].content) {
                if (/^\[([ xX])\]\s*/.test(tokens[i].content)) {
                    hasTaskItems = true;
                    break;
                }
            }
        }

        if (hasTaskItems) {
            tokens[idx].attrJoin('class', 'task-list');
        }

        return defaultListOpen(tokens, idx, options, env, self);
    };

    return md;
};
