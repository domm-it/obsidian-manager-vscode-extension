// Add copy buttons to code blocks in markdown preview
(function() {
    'use strict';

    // Multiple strategies to catch content changes
    let debounceTimeout;
    let lastContentCheck = '';
    
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

    // Add enhancements when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeMarkdownEnhancements);
    } else {
        initializeMarkdownEnhancements();
    }

    /*================================================================
    // region - MUTATION OBSERVER
    ================================================================*/
    const observer = new MutationObserver((mutations) => {
        let shouldUpdate = false;
        
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList') {
                shouldUpdate = true;
            }
        });
        
        if (shouldUpdate) {
            checkForContentChanges();
        }
    });

        function checkForContentChanges() {
        try {
            const currentContent = document.body.innerHTML;
            if (currentContent !== lastContentCheck) {
                lastContentCheck = currentContent;
                
                // Clear existing timeout
                if (debounceTimeout) {
                    clearTimeout(debounceTimeout);
                }
                
                debounceTimeout = setTimeout(() => {
                    try {
                        initializeMarkdownEnhancements();
                    } catch (e) {
                        console.warn('Error in checkForContentChanges:', e);
                    }
                }, 500);
            }
        } catch (e) {
            console.warn('Error in checkForContentChanges:', e);
        }
    }

    function startPeriodicCheck() {
        setInterval(checkForContentChanges, 2000);
    }

    function setupFocusListener() {
        try {
            window.addEventListener('focus', () => {
                setTimeout(checkForContentChanges, 100);
            });
        } catch (e) {
            // Ignore if can't add focus listener
        }
    }

    // Start all strategies
    try {
        if (document && document.body && typeof MutationObserver !== 'undefined') {
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: false,
                characterData: false
            });
        }
        
        startPeriodicCheck();
        setupFocusListener();
        
    } catch (e) {
        console.warn('Could not start change detection:', e);
        // Fallback to just periodic check
        setTimeout(initializeMarkdownEnhancements, 1000);
        startPeriodicCheck();
    }

    /*================================================================
    // region - INIT
    ================================================================*/
    function initializeMarkdownEnhancements() {
        try {
            // Re-create all copyButtons
            const copyButtons = document.querySelectorAll('.copy-button');
            copyButtons.forEach(button => {
                const preElement = button.closest('pre');
                if (!preElement || !preElement.contains(button.previousElementSibling)) {
                    button.remove();
                }
            });
            addCopyButtonsToCodeBlocks();

            addCopyToShortCode();

        } catch (e) {
            console.warn('Error in initializeMarkdownEnhancements:', e);
        }
    }

    /*================================================================
    // region - ADD COPY TO SHORT-CODE
    ================================================================*/
    function addCopyToShortCode() {
        console.log('TESTX', 'start');
        if (document.querySelector('.short-code-copy-button')) {
            return;
        }

        const codeElements = document.querySelectorAll('p>code');
        console.log('TESTX', codeElements);
        if (!codeElements) {
            return;
        }
        codeElements.forEach((codeElement) => {
            // Create wrapper span
            const wrapper = document.createElement('span');
            wrapper.className = 'short-code-container';

            // Clone the code element to preserve events/styles
            const codeClone = codeElement.cloneNode(true);

            // Create SVG icon for copy
            const copyIconWrapper = document.createElement('span');
            copyIconWrapper.className = 'short-code-copy-icon';

            const svgCopy = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgCopy.setAttribute('width', '16');
            svgCopy.setAttribute('height', '16');
            svgCopy.setAttribute('viewBox', '0 0 16 16');
            svgCopy.innerHTML = `
                <rect fill="none" x="4" y="4" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1"/>
                <rect fill="none" x="2" y="2" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1"/>
            `;
            copyIconWrapper.appendChild(svgCopy);
            
            // SVG icon for check
            const checkIconWrapper = document.createElement('span');
            checkIconWrapper.className = 'short-code-check-icon';
            const svgCheck = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgCheck.setAttribute('width', '16');
            svgCheck.setAttribute('height', '16');
            svgCheck.setAttribute('viewBox', '0 0 16 16');
            svgCheck.innerHTML = `
                <polyline points="4,9 7,12 12,5" stroke="currentColor" stroke-width="2" fill="none" />
            `;
            checkIconWrapper.appendChild(svgCheck);

            // Make the whole container clickable for copy
            wrapper.addEventListener('click', async (e) => {
                wrapper.classList.add('copying');
                e.preventDefault();
                e.stopPropagation();
                try {
                    await copyToClipboard(codeElement.textContent || '');
                    setTimeout(() => {
                        wrapper.classList.remove('copying');
                    }, 2000);
                } catch (err) {
                    // Optionally show error feedback
                }
            });

            // Build wrapper
            wrapper.appendChild(codeClone);
            wrapper.appendChild(checkIconWrapper);
            wrapper.appendChild(copyIconWrapper);

            // Replace original code element with wrapper
            const parent = codeElement.parentNode;
            if (parent) {
                parent.replaceChild(wrapper, codeElement);
            }
        });
    }

    /*================================================================
    // region - ADD COPY BUTTON
    ================================================================*/
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

    /*================================================================
    // region - COPY FUNCTIONS
    ================================================================*/
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

})();