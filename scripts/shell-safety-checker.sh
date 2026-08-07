#!/usr/bin/env bash
# shell-safety-checker.sh - Safety checker for shell scripts
# Based on ui/js-safety-checker.js pattern
# Integrates shellcheck for comprehensive static analysis

set -euo pipefail

# Check if shellcheck is available
SHELLCHECK_AVAILABLE=0
if command -v shellcheck >/dev/null 2>&1; then
    SHELLCHECK_AVAILABLE=1
fi

# Checks for loops that could be parallelized
# Returns warnings (non-blocking optimization suggestions) via stdout
function check_parallelization_opportunities() {
    local filePath="$1"
    local line_num=0
    local in_loop=0
    local loop_start_line=0
    local loop_body=""
    local loop_indent=""
    local loop_type="" # To store 'for', 'while', or 'until'

    # Read file line by line to handle nested structures
    while IFS= read -r line; do
        ((line_num++))

        # Detect the start of a loop (for, while, until)
        if [[ $in_loop -eq 0 && $line =~ ^([[:space:]]*)(for|while|until)[[:space:]]+.*do$ ]]; then
            in_loop=1
            loop_start_line=$line_num
            loop_indent="${BASH_REMATCH[1]}"
            loop_type="${BASH_REMATCH[2]}"
            loop_body=""
            continue
        fi

        # Detect the end of the loop
        if [[ $in_loop -eq 1 && $line =~ ^${loop_indent}done$ ]]; then
            # Heuristic: If the loop body is not already backgrounded, it's a candidate.
            # Check for '&' at the end of a command or 'wait' for PIDs
            # Note: Parallelization opportunities are optimization suggestions, not errors
            if ! echo "$loop_body" | grep -qE '&[[:space:]]*$|wait[[:space:]]+\$!|pids[[:space:]]*\+='; then
                echo "Potential parallelization opportunity: A '${loop_type}' loop was found at lines $loop_start_line-$line_num. If iterations are independent, consider parallelizing tasks (e.g., using '&' with 'wait', 'xargs -P', or 'parallel')."
            fi

            # Reset state for the next loop
            in_loop=0
            loop_body=""
            loop_start_line=0
            loop_indent=""
            loop_type=""
            continue
        fi

        # If inside a loop, append the current line to the loop_body
        if [[ $in_loop -eq 1 ]]; then
            loop_body+="$line\n"
        fi
    done < "$filePath"
}

# Add a new check for consecutive similar operations
# Returns warnings (non-blocking optimization suggestions) via stdout
function check_consecutive_similar_operations() {
    local filePath="$1"
    # Use awk to find consecutive lines with similar operations, ignoring common non-parallelizable keywords.
    awk -v blocklist_str="export local readonly unset echo log_info log_warn log_error if for while case select function time mkdir cp git source" '
            BEGIN {
                # Keywords/built-ins that are typically not candidates for parallelization
                split(blocklist_str, blocklist_arr, " ");
                for (i in blocklist_arr) {
                    is_blocklisted[blocklist_arr[i]] = 1;
                }
            }

            function check_and_report() {
                if (count >= 3 && !is_blocklisted[opName]) { # Check against blocklist
                    print "Potential parallelization opportunity: A block of " count " similar sequential operations (\"" opName "\") was found starting at line " startLine ". Consider refactoring into a parallelized loop or using '\''xargs -P'\'' / '\''parallel'\''.";
                }
            }

            # Match lines that look like operations, ignore empty or commented lines
            /^[[:space:]]*[a-zA-Z0-9_]+[[:space:]]+.*$/ {
                # Use the first word as the operation name
                op = $1;
                # Further refine op to ignore variable assignments or simple declarations
                if (op ~ /=/) { op = ""; } # Ignore assignments
                if (op == "local" || op == "export" || op == "readonly") { op = ""; } # Ignore declarations

                if (op != "") {
                    if (op == opName && ! /&[[:space:]]*$/) {
                        count++;
                    } else {
                        check_and_report();
                        opName = op;
                        startLine = NR;
                        count = 1;
                    }
                }
            }
            END { check_and_report(); }
        ' "$filePath"
}


function checkShellFile() {
    local filePath="$1"
    local issues=()
    local warnings=()

    # Check parallelization opportunities (warnings, not errors)
    # Capture warnings from functions that output to stdout
    while IFS= read -r warning; do
        warnings+=("$warning")
    done < <(check_parallelization_opportunities "$filePath")
    
    while IFS= read -r warning; do
        warnings+=("$warning")
    done < <(check_consecutive_similar_operations "$filePath")
    
    # Check for silent failures (|| true) - CRITICAL
    # Exception: Allow || true for non-blocking optional operations (e.g., CloudWatch logging, existence checks)
    if grep -q "|| true" "$filePath"; then
        # Check if it's part of a non-blocking optional operation pattern
        # For multiline AWS commands, check if file has both AWS list/get/describe AND || true
        local has_aws_list=0
        local has_aws_get=0
        local has_aws_describe=0
        if grep -qE "(aws.*list|aws acm)" "$filePath"; then
            has_aws_list=1
        fi
        if grep -qE "aws.*get" "$filePath"; then
            has_aws_get=1
        fi
        if grep -qE "aws.*describe" "$filePath"; then
            has_aws_describe=1
        fi
        
        # Check if it matches allowed patterns (same line or multiline for AWS commands)
        # Allow || true for AWS list/get/describe commands (handles multiline patterns)
        local is_allowed=0
        if grep -qE "(2>/dev/null \|\| true|>/dev/null \|\| true|\|\| true.*2>/dev/null|send_to_cloudwatch.*\|\| true|\|\| true.*cloudwatch)" "$filePath"; then
            is_allowed=1
        elif [[ ($has_aws_list -eq 1 || $has_aws_get -eq 1 || $has_aws_describe -eq 1) ]]; then
            is_allowed=1
        fi
        
        if [[ $is_allowed -eq 0 ]]; then
            issues+=("Silent failure detected: || true")
        fi
    fi
    
    # Check for missing set -euo pipefail - CRITICAL
    # Check first 20 lines to allow for comments/headers
    if ! head -20 "$filePath" | grep -q "set -euo pipefail"; then
        issues+=("Missing 'set -euo pipefail'")
    fi

    # Check for dangerous combination: set -e with background jobs - CRITICAL SILENT FAILURE RISK
    # Behavior-based detection rather than syntax-based
    local has_background_job=0
    local has_pid_capture=0
    local has_wait_for_pid=0
    local has_exit_code_check=0

    # Check for background jobs (any command ending with &)
    if grep -qE '\&[[:space:]]*$' "$filePath"; then
        has_background_job=1
    fi

    # Check for PID capture behavior (any mechanism that stores $!)
    # This includes: var=$!, array[key]=$!, var="${var}$!", etc.
    if grep -qE '\$![[:space:]]*\)?[[:space:]]*$|\$![[:space:]]*\)?[[:space:]]*;|\$![[:space:]]*\)?[[:space:]]*&' "$filePath" || \
       grep -qE '[a-zA-Z0-9_]+(\[[^]]+\])?[[:space:]]*=[[:space:]]*.*\$!' "$filePath"; then
        has_pid_capture=1
    fi

    # Check for wait behavior (any wait command that could wait for specific processes)
    # This includes: wait, wait $var, wait ${var}, wait $!, wait "${var}", etc.
    if grep -qE 'wait[[:space:]]*$|wait[[:space:]]+[^[:space:]]+' "$filePath"; then
        has_wait_for_pid=1
    fi

    # Check for exit code check behavior (any mechanism that checks $?)
    # This includes: var=$?, if [[ $? -eq 0 ]], if [ $? = 0 ], if ! wait, wait || log, etc.
    if grep -qE '\$\?[[:space:]]*\)?[[:space:]]*$|\$\?[[:space:]]*\)?[[:space:]]*;|[a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*.*\$\?|if[[:space:]]+.*\$\?|\[\[[[:space:]]*.*\$\?|if[[:space:]]+!.*wait|if.*wait.*pids|wait.*pids.*then|wait[[:space:]]+.*\|\||wait[[:space:]]+\$.*\|\|' "$filePath"; then
        has_exit_code_check=1
    fi

    if [[ $has_background_job -eq 1 ]]; then
        if [[ $has_pid_capture -eq 0 || $has_wait_for_pid -eq 0 || $has_exit_code_check -eq 0 ]]; then
            issues+=("CRITICAL SILENT FAILURE RISK: Background jobs ('&') with 'set -e' can fail silently. Ensure PIDs are captured, waited on, and their exit codes are explicitly checked. (Detected: BG_JOB=$has_background_job, PID_CAP=$has_pid_capture, WAIT=$has_wait_for_pid, EXIT_CHECK=$has_exit_code_check)")
        fi
    fi
    
    # Check for proper shebang - CRITICAL
    if ! head -1 "$filePath" | grep -q "^#!/.*bash"; then
        issues+=("Missing or incorrect shebang")
    fi
    
    # Check for hardcoded credentials - SECURITY (more specific patterns)
    # Exception: Variable assignments from environment variables are OK
    if grep -qiE "(password|secret|api_key|api-key)\s*=\s*[a-zA-Z0-9_]{10,}" "$filePath" && ! grep -qE "\$\{.*\}.*=" "$filePath"; then
        # Check if it's from an environment variable or parameter store
        if ! grep -qE "(getenv|os\.environ|\$\{.*:-|\$\(.*\)|\$\{.*\}|\$\$|aws ssm|parameter.*store)" "$filePath"; then
            issues+=("Potential hardcoded credential detected")
        fi
    fi
    
    # Run shellcheck if available
    if [[ $SHELLCHECK_AVAILABLE -eq 1 ]]; then
        # Run shellcheck and capture only errors (warnings are non-blocking)
        local shellcheck_output
        shellcheck_output=$(shellcheck --severity=error "$filePath" 2>&1 || true)

        if [[ -n "$shellcheck_output" ]]; then
            issues+=("SHELLCHECK FINDINGS:")
            # Parse shellcheck output and add as issues
            while IFS= read -r line; do
                if [[ -n "$line" ]]; then
                    issues+=("  $line")
                fi
            done <<< "$shellcheck_output"
        fi
    fi

    # Return issues
    if [[ ${#issues[@]} -gt 0 ]]; then
        echo "ERROR: $filePath"
        for issue in "${issues[@]}"; do
            echo "  - $issue"
        done
        # Print warnings if any (non-blocking)
        if [[ ${#warnings[@]} -gt 0 ]]; then
            echo "  WARNINGS (non-blocking):"
            for warning in "${warnings[@]}"; do
                echo "    - $warning"
            done
        fi
        return 1
    else
        # Print warnings even if no errors
        if [[ ${#warnings[@]} -gt 0 ]]; then
            echo "OK: $filePath (with warnings)"
            for warning in "${warnings[@]}"; do
                echo "  WARNING (non-blocking): $warning"
            done
        else
            echo "OK: $filePath"
        fi
        return 0
    fi
}

# Main execution - only run if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    # Temporarily disable strict mode for main execution
    set +euo pipefail
    
    echo "Shell Script Safety Checker"
    echo "=========================="
    if [[ $SHELLCHECK_AVAILABLE -eq 1 ]]; then
        echo "Using shellcheck for static analysis (warnings and errors)"
    else
        echo "WARNING: shellcheck not found - install with 'apt-get install shellcheck' for comprehensive analysis"
    fi
    echo ""

    totalIssues=0
    fileCount=0
    targetDir="${1:-.}"

    if [ -f "$targetDir" ]; then
        checkShellFile "$targetDir" || totalIssues=1
        fileCount=1
    else
        # Check all shell scripts except this safety checker
        while IFS= read -r -d '' file; do
            # Skip the safety checker itself
            if [[ "$file" != *"shell-safety-checker.sh" ]]; then
                ((fileCount++))
                checkShellFile "$file" || ((totalIssues++))
            fi
        done < <(find "$targetDir" -name "*.sh" -type f -not -path "*/venv/*" -not -path "*/.venv*" -print0)
    fi

    echo ""
    echo "Safety Check Summary"
    echo "==================="
    echo "Files checked: $fileCount"
    echo "Files with issues: $totalIssues"

    echo ""
    echo "Final Result"
    echo "============"

    if [[ $totalIssues -eq 0 ]]; then
        echo "✓ All checks passed!"
        exit 0
    else
        echo "✗ Safety check failed"
        exit 1
    fi
fi
