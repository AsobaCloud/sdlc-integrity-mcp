const fs = require('fs');
const vm = require('vm');
const path = require('path');
const esprima = require('esprima');

function checkJSFile(filePath, fileContent) {
    const issues = [];
    
    // 1. JAVASCRIPT SYNTAX VALIDATION
    try {
        const scriptMatches = fileContent.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
        // Only match actual JavaScript event handlers in HTML markup.
        // Skip .js files entirely (they don't have real HTML inline handlers).
        // For .html files, strip <script> blocks first so we don't match onclick
        // inside JS string concatenation or template literals.
        let inlineScripts = [];
        if (filePath.endsWith('.html')) {
            const htmlOnly = fileContent.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
            inlineScripts = htmlOnly.match(/\s(onclick|onload|onchange|onsubmit|onmouseover|onmouseout|onfocus|onblur|onkeydown|onkeyup)="[^"]*"/g) || [];
        }
        
        scriptMatches.forEach((scriptBlock, index) => {
            const scriptContent = scriptBlock.replace(/<\/?script[^>]*>/g, '');
            if (scriptContent.trim()) {
                try {
                    vm.createScript(scriptContent, `script-block-${index}`);
                } catch (error) {
                    const lineNumber = getLineNumber(fileContent, scriptBlock);
                    issues.push(`JavaScript syntax error in script block ${index + 1} at line ${lineNumber}: ${error.message}`);
                }
            }
        });
        
        inlineScripts.forEach((inlineScript, index) => {
            const jsCodeMatch = inlineScript.match(/="([^"]*)"/);
            if (jsCodeMatch && jsCodeMatch[1]) {
                const jsCode = jsCodeMatch[1];
                if (jsCode.trim()) {
                    try {
                        // Wrap in function context to allow return statements
                        vm.createScript(`(function(){${jsCode}})`, `inline-script-${index}`);
                    } catch (error) {
                        const lineNumber = getLineNumber(fileContent, inlineScript);
                        issues.push(`JavaScript syntax error in inline script at line ${lineNumber}: ${error.message}`);
                    }
                }
            }
        });
        
    } catch (error) {
        issues.push(`JavaScript parsing failed: ${error.message}`);
    }
    
    // 2. DUPLICATE DEFINITIONS - Use AST-based detection for accuracy
    const scriptBlocks = fileContent.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
    const allFunctionNames = [];
    
    scriptBlocks.forEach(scriptBlock => {
        const scriptContent = scriptBlock.replace(/<\/?script[^>]*>/g, '');
        try {
            const ast = esprima.parseScript(scriptContent, { tolerant: true });
            function findFunctions(node) {
                if (!node) return;
                if (node.type === 'FunctionDeclaration' && node.id) {
                    allFunctionNames.push(node.id.name);
                }
                for (const key in node) {
                    if (node.hasOwnProperty(key) && typeof node[key] === 'object' && node[key] !== null) {
                        if (Array.isArray(node[key])) {
                            node[key].forEach(findFunctions);
                        } else {
                            findFunctions(node[key]);
                        }
                    }
                }
            }
            findFunctions(ast);
        } catch (e) {
            // If AST parsing fails, fall back to regex but be more careful
            const functionDefinitions = scriptContent.match(/^\s*function\s+(\w+)/gm) || [];
            functionDefinitions.forEach(f => {
                const match = f.match(/function\s+(\w+)/);
                if (match) allFunctionNames.push(match[1]);
            });
        }
    });
    
    const duplicateFunctions = allFunctionNames.filter((func, index) => allFunctionNames.indexOf(func) !== index);
    if (duplicateFunctions.length > 0) {
        issues.push(`Duplicate function definitions: ${duplicateFunctions.join(', ')}`);
    }

    // Only check for duplicate IDs in static HTML, ignore dynamic IDs with concatenation
    // Match id="..." but exclude patterns with string concatenation (+ or ${})
    const idMatches = fileContent.match(/id="([^"]+)"/g) || [];
    const ids = idMatches
        .map(match => match.match(/id="([^"]+)"/)[1])
        .filter(id => !id.includes("' +") && !id.includes("+ '") && !id.includes('${') && !id.includes('}'));
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
        issues.push(`Duplicate IDs: ${duplicateIds.join(', ')}`);
    }

    return issues;
}

function getLineNumber(content, searchString) {
    const index = content.indexOf(searchString);
    return index !== -1 ? content.substring(0, index).split('\n').length : 0;
}

function findFiles(dir, ext, callback) {
    fs.readdir(dir, (err, files) => {
        if (err) return callback(err);

        files.forEach(file => {
            const filePath = path.join(dir, file);
            fs.stat(filePath, (err, stat) => {
                if (err) return callback(err);

                if (stat.isDirectory()) {
                    findFiles(filePath, ext, callback);
                } else if (path.extname(filePath) === ext) {
                    callback(null, filePath);
                }
            });
        });
    });
}

function analyzeJS(jsContent) {
    const declaredFunctions = new Set();
    const declaredClasses = new Set();
    const calledFunctions = new Set();

    try {
        const ast = esprima.parseScript(jsContent, { tolerant: true });

        function traverse(node) {
            if (!node) return;

            // Track function declarations
            if (node.type === 'FunctionDeclaration' && node.id) {
                declaredFunctions.add(node.id.name);
            }

            // Track arrow function and function expression assignments:
            // const/let/var name = () => {} or const/let/var name = function() {}
            if (node.type === 'VariableDeclaration') {
                node.declarations.forEach(declarator => {
                    if (declarator.id && declarator.id.type === 'Identifier' && declarator.init &&
                        (declarator.init.type === 'ArrowFunctionExpression' ||
                         declarator.init.type === 'FunctionExpression')) {
                        declaredFunctions.add(declarator.id.name);
                    }
                });
            }

            // Track class declarations
            if (node.type === 'ClassDeclaration' && node.id) {
                declaredClasses.add(node.id.name);
            }

            // Track function calls (e.g., myFunction())
            if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
                calledFunctions.add(node.callee.name);
            }

            // Track constructor calls (e.g., new MyClass())
            if (node.type === 'NewExpression' && node.callee.type === 'Identifier') {
                calledFunctions.add(node.callee.name);
            }

            for (const key in node) {
                if (node.hasOwnProperty(key)) {
                    const child = node[key];
                    if (typeof child === 'object' && child !== null) {
                        if (Array.isArray(child)) {
                            child.forEach(traverse);
                        } else {
                            traverse(child);
                        }
                    }
                }
            }
        }

        traverse(ast);
    } catch (e) {
        // Ignore parsing errors, they are handled by the vm module
    }

    // Combine declared functions and classes for checking
    const allDeclared = new Set([...declaredFunctions, ...declaredClasses]);
    return { declaredFunctions: allDeclared, calledFunctions };
}

function main() {
    const uiDir = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
    let allIssues = [];
    let filesToProcess = [];
    const extensions = ['.html', '.js'];
    
    // Files and directories to exclude from safety checking
    const excludePatterns = [
        'js-safety-checker.js',  // Don't scan the safety checker itself
        'node_modules',          // Exclude dependencies
        'dist',                  // Exclude build outputs
        'build',                 // Exclude build outputs
        '.git',                  // Exclude git directory
        'tests'                  // Exclude test files (Jest globals are not defined in production)
    ];

    const fileFinder = (dir, ext) => {
        if (!fs.existsSync(dir)) return;
        const stat = fs.statSync(dir);
        if (stat.isFile()) {
            if (path.extname(dir) === ext) {
                filesToProcess.push(dir);
            }
            return;
        }

        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const filePath = path.join(dir, file);
            
            // Skip excluded files and directories
            const shouldExclude = excludePatterns.some(pattern => 
                file.includes(pattern) || filePath.includes(pattern)
            );
            if (shouldExclude) {
                return;
            }
            
            const fileStat = fs.statSync(filePath);
            if (fileStat.isDirectory()) {
                fileFinder(filePath, ext);
            } else if (path.extname(filePath) === ext) {
                filesToProcess.push(filePath);
            }
        });
    };

    extensions.forEach(ext => fileFinder(uiDir, ext));

    const allDeclaredFunctions = new Set();
    const allCalledFunctions = new Set();

    filesToProcess.forEach(filePath => {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const issues = checkJSFile(filePath, fileContent);
        if (issues.length > 0) {
            allIssues.push({ filePath, issues });
        }

        const { declaredFunctions, calledFunctions } = analyzeJS(fileContent);
        declaredFunctions.forEach(f => allDeclaredFunctions.add(f));
        calledFunctions.forEach(f => allCalledFunctions.add(f));
    });

    // Browser and Node.js global functions that should not be flagged as undefined
    const knownGlobals = new Set([
        'fetch', 'alert', 'confirm', 'prompt', 'console', 'setTimeout', 'setInterval',
        'clearTimeout', 'clearInterval', 'document', 'window', 'location', 'localStorage',
        'sessionStorage', 'JSON', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
        'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape', 'Date', 'Math',
        'Array', 'Object', 'String', 'Number', 'Boolean', 'RegExp', 'Error', 'require',
        'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
        'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect',
        'CustomEvent', 'Event', 'EventTarget', 'AbortController', 'AbortSignal',
        'FormData', 'URLSearchParams', 'URL', 'Blob', 'File', 'FileReader',
        'XMLHttpRequest', 'WebSocket', 'MutationObserver', 'IntersectionObserver',
        'ResizeObserver', 'PerformanceObserver', 'atob', 'btoa',
        'EventSource', 'TextDecoder', 'TextEncoder'
    ]);

    // Common callback parameter names that should not be flagged as undefined
    const commonCallbackNames = new Set([
        'callback', 'cb', 'done', 'next', 'fn', 'handler', 'onSuccess', 'onError',
        'onConfirm', 'onCancel', 'resolve', 'reject', 'complete', 'unsubscribe',
        'listener', 'subscriber', 'observer',
        'onComplete', 'onProgress', 'onChunk', 'onDone'
    ]);

    const undefinedFunctions = [...allCalledFunctions].filter(f =>
        !allDeclaredFunctions.has(f) && !knownGlobals.has(f) && !commonCallbackNames.has(f)
    );

    if (undefinedFunctions.length > 0) {
        allIssues.push({ filePath: 'Global', issues: [`Undefined function calls: ${undefinedFunctions.join(', ')}`] });
    }

    if (allIssues.length > 0) {
        console.error('JavaScript Safety Check Failed:');
        allIssues.forEach(fileIssues => {
            console.error(`\n❌ ${fileIssues.filePath}`);
            fileIssues.issues.forEach(issue => {
                console.error(`  - ${issue}`);
            });
        });
        process.exit(1);
    } else {
        console.log(`✅ All ${filesToProcess.length} files checked: No issues found`);
    }
}

main();
