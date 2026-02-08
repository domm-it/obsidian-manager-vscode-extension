// Add copy buttons to code blocks in markdown preview
(function() {
    'use strict';

    // Multiple strategies to catch content changes
    let debounceTimeout;
    let lastContentCheck = '';
    let isProcessing = false; // Flag to prevent infinite loops
    
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
            if (isProcessing) {
                return; // Skip if already processing
            }
            
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
                }, 1000); // Increased to 1 second to reduce flickering
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
        if (isProcessing) {
            return; // Prevent re-entry
        }
        
        try {
            isProcessing = true;
            
            // Temporarily disconnect observer to prevent infinite loops
            observer.disconnect();
            
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
            
            enhanceHashtags();
            
            enhanceTaskCheckboxes();

        } catch (e) {
            console.warn('Error in initializeMarkdownEnhancements:', e);
        } finally {
            isProcessing = false;
            
            // Reconnect observer after a short delay
            setTimeout(() => {
                if (document && document.body) {
                    observer.observe(document.body, {
                        childList: true,
                        subtree: true,
                        attributes: false,
                        characterData: false
                    });
                }
            }, 100);
        }
    }

    /*================================================================
    // region - HASHTAGS
    ================================================================*/
    function enhanceHashtags() {
        try {
            // Find all text nodes and wrap hashtags
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: function(node) {
                        // Skip if parent is already marked as processed
                        if (node.parentElement && node.parentElement.hasAttribute('data-hashtag-processed')) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        // Skip if already processed or inside code/pre
                        if (node.parentElement && 
                            (node.parentElement.classList.contains('hashtag') ||
                             node.parentElement.tagName === 'CODE' ||
                             node.parentElement.tagName === 'PRE' ||
                             node.parentElement.closest('pre, code'))) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        // Only process if text contains #
                        if (node.textContent && node.textContent.includes('#')) {
                            return NodeFilter.FILTER_ACCEPT;
                        }
                        return NodeFilter.FILTER_REJECT;
                    }
                }
            );

            const nodesToProcess = [];
            let node;
            while (node = walker.nextNode()) {
                nodesToProcess.push(node);
            }

            // Process nodes and wrap hashtags
            nodesToProcess.forEach(textNode => {
                const text = textNode.textContent;
                // Match hashtags: # followed by alphanumeric characters, underscores, or hyphens
                const hashtagRegex = /#([a-zA-Z0-9_\-À-ÿ]+)/g;
                
                if (hashtagRegex.test(text)) {
                    const fragment = document.createDocumentFragment();
                    let lastIndex = 0;
                    
                    text.replace(hashtagRegex, (match, tag, offset) => {
                        // Add text before hashtag
                        if (offset > lastIndex) {
                            fragment.appendChild(document.createTextNode(text.substring(lastIndex, offset)));
                        }
                        
                        // Create hashtag span
                        const hashtagSpan = document.createElement('span');
                        hashtagSpan.className = 'hashtag';
                        hashtagSpan.textContent = match;
                        hashtagSpan.setAttribute('data-hashtag', tag);
                        fragment.appendChild(hashtagSpan);
                        
                        lastIndex = offset + match.length;
                        return match;
                    });
                    
                    // Add remaining text
                    if (lastIndex < text.length) {
                        fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
                    }
                    
                    // Replace original text node with fragment
                    if (textNode.parentNode) {
                        textNode.parentNode.replaceChild(fragment, textNode);
                        // Mark parent as processed to avoid re-processing
                        if (textNode.parentNode.nodeType === Node.ELEMENT_NODE) {
                            textNode.parentNode.setAttribute('data-hashtag-processed', 'true');
                        }
                    }
                }
            });
        } catch (e) {
            // Silent fail
        }
    }

    /*================================================================
    // region - TASK CHECKBOXES
    ================================================================*/
    let checkboxServerInitialized = false;
    let checkboxServerPort = null;
    let checkboxServerNonce = null;
    let checkboxSourceFile = null;
    let isSavingCheckbox = false; // Global flag to prevent concurrent saves
    
    function enhanceTaskCheckboxes() {
        try {
            // Get server data from the injected div (only once)
            if (!checkboxServerInitialized) {
                const serverDataDiv = document.getElementById('mdCheckboxServerData');
                if (!serverDataDiv) {
                    return;
                }
                
                checkboxServerPort = serverDataDiv.getAttribute('data-port');
                checkboxServerNonce = serverDataDiv.getAttribute('data-nonce');
                
                if (!checkboxServerPort || !checkboxServerNonce) {
                    return;
                }
                
                // Get the source file from the base tag
                const baseTag = document.querySelector('base');
                if (baseTag && baseTag.href) {
                    checkboxSourceFile = baseTag.href;
                }
                
                if (!checkboxSourceFile) {
                    return;
                }
                
                // Use event delegation - single listener on document for all checkboxes
                document.addEventListener('change', handleCheckboxChange, true);
                
                checkboxServerInitialized = true;
            }
            
            // Find all checkbox inputs and make them interactive
            let checkboxes = document.querySelectorAll('input[type="checkbox"].task-list-item-checkbox:not([data-enhanced])');
            
            if (checkboxes.length === 0) {
                checkboxes = document.querySelectorAll('.task-list-item input[type="checkbox"]:not([data-enhanced])');
            }
            
            if (checkboxes.length === 0) {
                checkboxes = document.querySelectorAll('.task-list input[type="checkbox"]:not([data-enhanced])');
            }
            
            checkboxes.forEach((checkbox) => {
                // Mark as enhanced and enable
                checkbox.setAttribute('data-enhanced', 'true');
                checkbox.removeAttribute('disabled');
                checkbox.style.cursor = 'pointer';
            });
        } catch (e) {
            // Silent fail
        }
    }
    
    function handleCheckboxChange(e) {
        const checkbox = e.target;
        
        // Check if this is a task list checkbox
        if (checkbox.type !== 'checkbox') {
            return;
        }
        
        const listItem = checkbox.closest('li.task-list-item');
        if (!listItem) {
            return;
        }
        
        // Get line number
        const lineNumber = listItem.getAttribute('data-line');
        if (!lineNumber) {
            return;
        }
        
        // If already saving, prevent this change
        if (isSavingCheckbox) {
            e.preventDefault();
            e.stopPropagation();
            checkbox.checked = !checkbox.checked; // Revert the change
            return;
        }
        
        e.stopPropagation();
        
        const checked = checkbox.checked;
        
        // Set saving flag and disable ALL checkboxes
        isSavingCheckbox = true;
        const allCheckboxes = document.querySelectorAll('input[type="checkbox"]');
        allCheckboxes.forEach(cb => {
            cb.disabled = true;
            cb.style.opacity = '0.5';
        });
        
        try {
            const url = `http://localhost:${checkboxServerPort}/checkbox/mark?source=${encodeURIComponent(checkboxSourceFile)}&line=${lineNumber}&checked=${checked}&nonce=${encodeURIComponent(checkboxServerNonce)}`;
            
            // Use Image to bypass CSP
            const img = new Image();
            
            const reEnableCheckboxes = () => {
                // Wait for file save and preview reload
                setTimeout(() => {
                    isSavingCheckbox = false;
                    const allCheckboxes = document.querySelectorAll('input[type="checkbox"]');
                    allCheckboxes.forEach(cb => {
                        cb.disabled = false;
                        cb.style.opacity = '1';
                    });
                }, 300);
            };
            
            img.onload = reEnableCheckboxes;
            img.onerror = reEnableCheckboxes;
            
            img.src = url;
            
        } catch (error) {
            // Re-enable on error
            isSavingCheckbox = false;
            const allCheckboxes = document.querySelectorAll('input[type="checkbox"]');
            allCheckboxes.forEach(cb => {
                cb.disabled = false;
                cb.style.opacity = '1';
            });
            checkbox.checked = !checked;
        }
    }

    /*================================================================
    // region - ADD COPY TO SHORT-CODE
    ================================================================*/
    function addCopyToShortCode() {
        // Find code elements that haven't been wrapped yet
        const codeElements = Array.from(document.querySelectorAll('code:not([data-copy-enhanced])')).filter(
            code => !code.closest('pre') && !code.closest('.short-code-container')
        );
        if (!codeElements || codeElements.length === 0) {
            return;
        }
        codeElements.forEach((codeElement) => {
            // Mark as enhanced before wrapping
            codeElement.setAttribute('data-copy-enhanced', 'true');
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

    /*================================================================
    // region - INITIALIZATION
    ================================================================*/
    // Add enhancements when DOM is ready
    // This must be at the end after all functions are defined
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeMarkdownEnhancements);
    } else {
        initializeMarkdownEnhancements();
    }

})();