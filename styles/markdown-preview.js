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

})();