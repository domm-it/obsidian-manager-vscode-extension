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
                }, 300); // 300ms for quick updates
            }
        } catch (e) {
            console.warn('Error in checkForContentChanges:', e);
        }
    }

    function startPeriodicCheck() {
        setInterval(checkForContentChanges, 5000); // Reduced frequency: 5s instead of 2s
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
                characterData: false,
                attributeOldValue: false,
                characterDataOldValue: false
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
            
            enhanceHeaderAccordions();

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
                        characterData: false,
                        attributeOldValue: false,
                        characterDataOldValue: false
                    });
                }
            }, 50); // Reduced from 100ms to 50ms
        }
    }

    /*================================================================
    // region - HEADER ACCORDIONS
    ================================================================*/
    // Simple hash function for accordion IDs
    function simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(36);
    }
    
    function enhanceHeaderAccordions() {
        try {
            // Find all headers that aren't already enhanced - optimized selector
            const headers = document.querySelectorAll('h1:not([data-accordion-enhanced]), h2:not([data-accordion-enhanced]), h3:not([data-accordion-enhanced]), h4:not([data-accordion-enhanced]), h5:not([data-accordion-enhanced]), h6:not([data-accordion-enhanced])');
            
            // Early exit if no headers to process
            if (headers.length === 0) {
                return;
            }
            
            // Cache base tag and file path lookup
            const baseTag = document.querySelector('base');
            const filePath = baseTag ? baseTag.href : 'unknown';
            
            // Use DocumentFragment for batch operations
            const headerArray = Array.from(headers);
            
            headerArray.forEach(header => {
                // Mark as enhanced
                header.setAttribute('data-accordion-enhanced', 'true');
                
                // Get header level (1-6)
                const level = parseInt(header.tagName.substring(1));
                
                // Find content until next header of same or higher level
                const content = [];
                let sibling = header.nextElementSibling;
                
                while (sibling) {
                    const siblingTag = sibling.tagName;
                    
                    // Stop if we hit a header of same or higher level (lower number)
                    if (/^H[1-6]$/.test(siblingTag)) {
                        const siblingLevel = parseInt(siblingTag.substring(1));
                        if (siblingLevel <= level) {
                            break;
                        }
                    }
                    
                    content.push(sibling);
                    sibling = sibling.nextElementSibling;
                }
                
                // Only add accordion if there's content
                if (content.length > 0) {
                    // Create unique ID for this accordion using hash
                    const headerText = header.textContent.trim();
                    const rawId = `${filePath}_${level}_${headerText}`;
                    const accordionId = `accordion_${simpleHash(rawId)}`;
                    
                    // Check localStorage: if key exists, it's closed; otherwise it's open (default)
                    let isOpen = true;
                    try {
                        const exists = localStorage.getItem(accordionId);
                        if (exists !== null) {
                            isOpen = false; // Key exists = accordion is closed
                        }
                    } catch (e) {
                        // localStorage might be disabled
                    }
                    
                    // Add accordion classes
                    header.classList.add('accordion-header');
                    header.setAttribute('data-accordion-open', String(isOpen));
                    header.setAttribute('data-accordion-id', accordionId);
                    
                    // Create arrow icon using SVG
                    const arrow = document.createElement('span');
                    arrow.className = 'accordion-arrow';
                    arrow.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" width="512" height="512"><path d="M9,17.88V6.71A1,1,0,0,1,10.71,6l5.58,5.59a1,1,0,0,1,0,1.41l-5.58,5.59A1,1,0,0,1,9,17.88Z"/></svg>`;
                    header.insertBefore(arrow, header.firstChild);
                    
                    // Add ellipsis indicator for closed state
                    const ellipsis = document.createElement('span');
                    ellipsis.className = 'accordion-ellipsis';
                    ellipsis.textContent = ' ...';
                    header.appendChild(ellipsis);
                    
                    // Wrap content in container using DocumentFragment
                    const wrapper = document.createElement('div');
                    wrapper.className = 'accordion-content';
                    wrapper.setAttribute('data-accordion-open', String(isOpen));
                    
                    // Use DocumentFragment for efficient batch append
                    const fragment = document.createDocumentFragment();
                    content.forEach(el => {
                        fragment.appendChild(el); // Move instead of clone+remove
                    });
                    wrapper.appendChild(fragment);
                    
                    // Insert wrapper after header
                    header.parentNode.insertBefore(wrapper, header.nextSibling);
                    
                    // Apply initial state
                    if (!isOpen) {
                        wrapper.style.maxHeight = '0';
                        wrapper.style.opacity = '0';
                    } else {
                        wrapper.style.opacity = '1';
                    }
                    
                    // Add click handler
                    header.addEventListener('click', function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        
                        const currentOpen = header.getAttribute('data-accordion-open') === 'true';
                        const newState = !currentOpen;
                        
                        header.setAttribute('data-accordion-open', String(newState));
                        wrapper.setAttribute('data-accordion-open', String(newState));
                        
                        // Save/remove state from localStorage
                        try {
                            if (newState) {
                                // Opening: remove from localStorage
                                localStorage.removeItem(accordionId);
                            } else {
                                // Closing: save to localStorage
                                localStorage.setItem(accordionId, '1');
                            }
                        } catch (e) {
                            // localStorage might be disabled
                        }
                        
                        if (newState) {
                            wrapper.style.opacity = '1';
                            wrapper.style.maxHeight = wrapper.scrollHeight + 'px';
                            setTimeout(() => {
                                wrapper.style.maxHeight = 'none';
                            }, 300);
                        } else {
                            wrapper.style.opacity = '0';
                            wrapper.style.maxHeight = wrapper.scrollHeight + 'px';
                            setTimeout(() => {
                                wrapper.style.maxHeight = '0';
                            }, 10);
                        }
                    });
                    
                    // Set cursor pointer
                    header.style.cursor = 'pointer';
                }
            });
        } catch (e) {
            // Silent fail
        }
    }

    /*================================================================
    // region - HASHTAGS
    ================================================================*/
    function enhanceHashtags() {
        try {
            // Optimize: Only process elements not already marked
            const unprocessedElements = document.querySelectorAll('p:not([data-hashtag-scanned]), li:not([data-hashtag-scanned]), td:not([data-hashtag-scanned]), th:not([data-hashtag-scanned])');
            
            if (unprocessedElements.length === 0) {
                return; // Nothing to process
            }
            
            // Find all text nodes and wrap hashtags - limited scope
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
                        hashtagSpan.style.cursor = 'pointer';
                        
                        // Add click handler for opening tasks
                        hashtagSpan.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openHashtagTasks(match);
                        });
                        
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
    
    function openHashtagTasks(hashtag) {
        try {
            // Get server data
            const serverDataDiv = document.getElementById('mdCheckboxServerData');
            if (!serverDataDiv) {
                return;
            }
            
            const port = serverDataDiv.getAttribute('data-port');
            const nonce = serverDataDiv.getAttribute('data-nonce');
            
            if (!port || !nonce) {
                return;
            }
            
            const url = `http://localhost:${port}/hashtag/open?tag=${encodeURIComponent(hashtag)}&nonce=${encodeURIComponent(nonce)}`;
            
            const img = new Image();
            img.src = url;
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
            
            // Find all checkbox inputs and make them interactive - optimized query
            let checkboxes = document.querySelectorAll('input[type="checkbox"].task-list-item-checkbox:not([data-enhanced]), .task-list-item input[type="checkbox"]:not([data-enhanced]), .task-list input[type="checkbox"]:not([data-enhanced])');
            
            // Early exit if no checkboxes to enhance
            if (checkboxes.length === 0) {
                return;
            }
            
            checkboxes.forEach((checkbox) => {
                // Mark as enhanced and enable
                checkbox.setAttribute('data-enhanced', 'true');
                checkbox.removeAttribute('disabled');
                checkbox.style.cursor = 'pointer';
                
                // Skip wrapper creation if already wrapped or no label
                const listItem = checkbox.closest('li.task-list-item');
                if (!listItem || checkbox.parentElement.classList.contains('task-checkbox-wrapper')) {
                    return;
                }
                
                // Find the label that follows the checkbox
                const label = checkbox.nextElementSibling;
                if (!label || label.tagName !== 'LABEL') {
                    return;
                }
                
                // Create wrapper efficiently
                const wrapper = document.createElement('div');
                wrapper.className = 'task-checkbox-wrapper';
                
                // Insert wrapper before checkbox
                checkbox.parentNode.insertBefore(wrapper, checkbox);
                
                // Move elements into wrapper
                wrapper.appendChild(checkbox);
                wrapper.appendChild(label);
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
        // Find code elements that haven't been wrapped yet - optimized query
        const codeElements = Array.from(document.querySelectorAll('code:not([data-copy-enhanced]):not(pre code)')).filter(
            code => !code.closest('.short-code-container')
        );
        if (codeElements.length === 0) {
            return; // Early exit
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
            // Only process pre elements without copy button
            const preElements = document.querySelectorAll('pre:not(:has(.copy-button))');
            if (preElements.length === 0) {
                return; // Early exit
            }
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