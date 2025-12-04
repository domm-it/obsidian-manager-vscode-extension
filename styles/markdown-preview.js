// Add copy buttons to code blocks in markdown preview
(function() {
    'use strict';
    
    // Catch any uncaught errors to prevent breaking the preview
    window.addEventListener('error', function(e) {
        console.warn('JavaScript error in markdown preview:', e.error);
        return true; // Prevent default error handling
    });



    function copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            // Use modern clipboard API
            return navigator.clipboard.writeText(text);
        } else {
            // Fallback for older browsers
            return new Promise((resolve, reject) => {
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'absolute';
                textArea.style.left = '-9999px';
                document.body.appendChild(textArea);
                textArea.select();
                try {
                    document.execCommand('copy');
                    document.body.removeChild(textArea);
                    resolve();
                } catch (err) {
                    document.body.removeChild(textArea);
                    reject(err);
                }
            });
        }
    }

    function addCopyButton(preElement) {
        // Skip if button already exists
        if (preElement.querySelector('.copy-button')) {
            return;
        }

        const codeElement = preElement.querySelector('code');
        if (!codeElement) {
            return;
        }

        // Create copy button
        const copyButton = document.createElement('button');
        copyButton.className = 'copy-button';
        copyButton.textContent = 'Copy';
        copyButton.title = 'Copy code to clipboard';

        // Add click handler
        copyButton.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            try {
                const code = codeElement.textContent || '';
                await copyToClipboard(code);
                
                // Show success feedback
                copyButton.textContent = 'Copied!';
                copyButton.classList.add('copied');
                
                // Reset after 2 seconds
                setTimeout(() => {
                    copyButton.textContent = 'Copy';
                    copyButton.classList.remove('copied');
                }, 2000);
                
            } catch (err) {
                console.error('Failed to copy code:', err);
                
                // Show error feedback
                copyButton.textContent = 'Failed';
                setTimeout(() => {
                    copyButton.textContent = 'Copy';
                }, 2000);
            }
        });

        // Add button to pre element
        preElement.style.position = 'relative';
        preElement.appendChild(copyButton);
    }

    function addCopyButtonsToCodeBlocks() {
        try {
            const preElements = document.querySelectorAll('pre');
            preElements.forEach((preElement) => {
                try {
                    addCopyButton(preElement);
                } catch (e) {
                    console.warn('Error adding copy button to element:', e);
                }
            });
        } catch (e) {
            console.warn('Error in addCopyButtonsToCodeBlocks:', e);
        }
    }

    // Add copy buttons when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addCopyButtonsToCodeBlocks);
    } else {
        addCopyButtonsToCodeBlocks();
    }

    // Re-add copy buttons when content changes (for dynamic updates)
    let debounceTimeout;
    const observer = new MutationObserver((mutations) => {
        let shouldUpdate = false;
        
        // Clear existing timeout
        if (debounceTimeout) {
            clearTimeout(debounceTimeout);
        }
        
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) { // Element node
                        if (node.tagName === 'PRE' || (node.querySelector && node.querySelector('pre'))) {
                            shouldUpdate = true;
                        }
                    }
                });
            }
        });
        
        if (shouldUpdate) {
            // Debounce the update to avoid excessive calls
            debounceTimeout = setTimeout(() => {
                try {
                    addCopyButtonsToCodeBlocks();
                } catch (e) {
                    console.warn('Error adding copy buttons:', e);
                }
            }, 200);
        }
    });

    // Start observing with more specific options to reduce noise
    try {
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false
        });
    } catch (e) {
        console.warn('Could not start MutationObserver:', e);
    }

    // Wiki-link functionality - use global API or acquire if not available
    let vscodeApi = window.vscodeApi;
    if (!vscodeApi) {
        try {
            vscodeApi = acquireVsCodeApi();
            window.vscodeApi = vscodeApi; // Store globally to avoid re-acquisition
        } catch (e) {
            console.warn('Unable to acquire VS Code API for wiki-links');
            return; // Exit if we can't get the API
        }
    }
    
    // Function to convert wiki-links to clickable elements
    function convertWikiLinks() {
        // Find all text nodes in the document
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    // Skip script and style elements
                    const parent = node.parentElement;
                    if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE' || parent.tagName === 'CODE')) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }

        // Process each text node for wiki-links
        textNodes.forEach(textNode => {
            const text = textNode.textContent;
            if (text && text.includes('[[') && text.includes(']]')) {
                // Found potential wiki-links
                const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
                let match;
                let hasMatches = false;
                
                // Check if there are actually wiki-link matches
                while ((match = wikiLinkRegex.exec(text)) !== null) {
                    hasMatches = true;
                }
                
                if (hasMatches) {
                    // Reset regex
                    wikiLinkRegex.lastIndex = 0;
                    
                    // Create a container with replaced content
                    const container = document.createElement('span');
                    let lastIndex = 0;
                    let newContent = '';
                    
                    while ((match = wikiLinkRegex.exec(text)) !== null) {
                        // Add text before the match
                        newContent += text.slice(lastIndex, match.index);
                        
                        // Create wiki-link element
                        const linkText = match[1];
                        let displayText = linkText;
                        let target = linkText;
                        
                        // Handle piped links [[target|display]]
                        if (linkText.includes('|')) {
                            const parts = linkText.split('|');
                            target = parts[0].trim();
                            displayText = parts[1].trim();
                        }
                        
                        // Create clickable link
                        const linkElement = document.createElement('a');
                        linkElement.className = 'wiki-link';
                        linkElement.setAttribute('data-href', target);
                        linkElement.textContent = displayText;
                        linkElement.href = '#';
                        
                        // Add click handlers for different behaviors
                        linkElement.addEventListener('click', function(e) {
                            e.preventDefault();
                            const openInNewTab = e.ctrlKey || e.metaKey; // Ctrl+click or Cmd+click for new tab
                            vscodeApi.postMessage({
                                command: 'openWikiLinkDirect',
                                target: target,
                                newTab: false
                            });
                        });
                        
                        // Add context menu for additional options
                        linkElement.addEventListener('contextmenu', function(e) {
                            e.preventDefault();
                            // Create context menu
                            const menu = document.createElement('div');
                            menu.className = 'wiki-link-context-menu';
                            menu.style.cssText = `
                                position: fixed;
                                top: ${e.clientY}px;
                                left: ${e.clientX}px;
                                background: var(--vscode-menu-background);
                                border: 1px solid var(--vscode-menu-border);
                                border-radius: 3px;
                                padding: 4px 0;
                                z-index: 10000;
                                font-size: 13px;
                                min-width: 150px;
                                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                            `;
                            
                            // Menu options
                            const options = [
                                { text: 'Open', action: () => vscodeApi.postMessage({ command: 'openWikiLinkDirect', target: target, newTab: false }) },
                                { text: 'Open in New Tab', action: () => vscodeApi.postMessage({ command: 'openWikiLinkDirect', target: target, newTab: true }) }
                            ];
                            
                            options.forEach(option => {
                                const item = document.createElement('div');
                                item.textContent = option.text;
                                item.style.cssText = `
                                    padding: 6px 12px;
                                    cursor: pointer;
                                    color: var(--vscode-menu-foreground);
                                `;
                                item.addEventListener('mouseenter', () => {
                                    item.style.backgroundColor = 'var(--vscode-menu-selectionBackground)';
                                });
                                item.addEventListener('mouseleave', () => {
                                    item.style.backgroundColor = 'transparent';
                                });
                                item.addEventListener('click', () => {
                                    option.action();
                                    document.body.removeChild(menu);
                                });
                                menu.appendChild(item);
                            });
                            
                            // Remove menu when clicking elsewhere
                            const removeMenu = (event) => {
                                if (!menu.contains(event.target)) {
                                    document.body.removeChild(menu);
                                    document.removeEventListener('click', removeMenu);
                                }
                            };
                            setTimeout(() => document.addEventListener('click', removeMenu), 0);
                            
                            document.body.appendChild(menu);
                        });
                        
                        // Add to content
                        const tempDiv = document.createElement('div');
                        tempDiv.appendChild(linkElement);
                        newContent += tempDiv.innerHTML;
                        
                        lastIndex = match.index + match[0].length;
                    }
                    
                    // Add remaining text
                    newContent += text.slice(lastIndex);
                    
                    // Replace the text node with our new content
                    container.innerHTML = newContent;
                    
                    // Replace text node with container contents
                    const parent = textNode.parentNode;
                    if (parent) {
                        while (container.firstChild) {
                            parent.insertBefore(container.firstChild, textNode);
                        }
                        parent.removeChild(textNode);
                    }
                }
            }
        });
    }

    // Initialize wiki-links
    function initializeWikiLinks() {
        addCopyButtonsToCodeBlocks();
        convertWikiLinks();
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeWikiLinks);
    } else {
        initializeWikiLinks();
    }

    // Update observer to also handle wiki-links
    const wikiObserver = new MutationObserver((mutations) => {
        let shouldUpdate = false;
        
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) { // Element node
                        if (node.tagName === 'PRE' || (node.querySelector && node.querySelector('pre'))) {
                            shouldUpdate = true;
                        }
                        // Also check for text content that might contain wiki-links
                        if (node.textContent && (node.textContent.includes('[[') || node.textContent.includes(']]'))) {
                            shouldUpdate = true;
                        }
                    }
                });
            }
        });
        
        if (shouldUpdate) {
            // Debounce the update
            setTimeout(() => {
                addCopyButtonsToCodeBlocks();
                convertWikiLinks();
            }, 100);
        }
    });

    // Start observing for both code blocks and wiki-links
    wikiObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

})();