// Add copy buttons to code blocks in markdown preview
(function() {
    'use strict';
    
    // Safety check - exit early if we're in an unsafe context
    if (!window || !document || !document.body) {
        return;
    }
    
    // Catch any uncaught errors to prevent breaking the preview
    try {
        window.addEventListener('error', function(e) {
            console.warn('JavaScript error in markdown preview:', e.error);
            return true; // Prevent default error handling
        });
    } catch (e) {
        // If we can't add error listener, continue without it
    }



    function copyToClipboard(text) {
        return new Promise((resolve, reject) => {
            try {
                // Check if we have access to clipboard API
                if (navigator && navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(text).then(resolve).catch(() => {
                        // Fallback if clipboard API fails
                        fallbackCopy(text, resolve, reject);
                    });
                } else {
                    fallbackCopy(text, resolve, reject);
                }
            } catch (e) {
                fallbackCopy(text, resolve, reject);
            }
        });
    }
    
    function fallbackCopy(text, resolve, reject) {
        try {
            if (!document || !document.body) {
                reject(new Error('Document not available'));
                return;
            }
            
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.cssText = 'position:absolute;left:-9999px;top:-9999px;opacity:0;';
            textArea.setAttribute('readonly', '');
            
            document.body.appendChild(textArea);
            textArea.select();
            textArea.setSelectionRange(0, text.length);
            
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            
            if (successful) {
                resolve();
            } else {
                reject(new Error('Copy command failed'));
            }
        } catch (err) {
            reject(err);
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
        if (document && document.body && typeof MutationObserver !== 'undefined') {
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: false,
                characterData: false
            });
        }
    } catch (e) {
        console.warn('Could not start MutationObserver:', e);
        // If MutationObserver fails, try a simpler approach
        try {
            setTimeout(addCopyButtonsToCodeBlocks, 1000);
        } catch (fallbackError) {
            // If everything fails, just continue without dynamic updates
        }
    }

})();