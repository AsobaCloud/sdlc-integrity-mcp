#!/usr/bin/env python3

import ast
import os
import subprocess
import sys

class PythonSafetyChecker:
    def __init__(self, root_path):
        self.root_path = root_path
        self.issues = []

    def check(self):
        self._check_dependencies()
        self._run_bandit()
        self._run_ruff()
        self._run_ast_checks()
        self._print_summary()

    def _check_dependencies(self):
        try:
            import importlib.util
            # Check if dependencies are available (imported but unused in code)
            importlib.util.find_spec('bandit')
            importlib.util.find_spec('ruff')
        except ImportError:
            print("ERROR: Missing dependencies. Please run 'pip install -r requirements-dev.txt' to install the required tools.")
            sys.exit(1)

    def _run_bandit(self):
        print("Running bandit...")
        try:
            # Exclude safety checker itself, test files, and build artifacts from Bandit checks
            result = subprocess.run(
                ['bandit', '-r', self.root_path,
                 '--exclude', 'scripts/python-safety-checker.py,tests/,*/test_*.py,.aws-sam/,build/,dist/,node_modules/,.venv/,venv/,./.venv-ci/,./.venv-configure-tests/,./_pt/,./.tvenv/,./.agent-venv/,.venv-ci/,.venv-configure-tests/,_pt/,.tvenv/,.agent-venv/'],
                capture_output=True, text=True
            )
            # Only report High/Critical severity issues as errors (warnings are non-blocking)
            if result.returncode == 1 and result.stdout:
                # Parse output to find only High/Critical severity issues
                lines = result.stdout.split('\n')
                high_critical_issues = []
                current_issue_lines = []
                in_high_critical_issue = False
                
                for i, line in enumerate(lines):
                    if '>> Issue:' in line:
                        # Start of new issue
                        if in_high_critical_issue and current_issue_lines:
                            high_critical_issues.extend(current_issue_lines)
                        current_issue_lines = [line]
                        in_high_critical_issue = False
                    elif 'Severity: High' in line or 'Severity: Critical' in line:
                        in_high_critical_issue = True
                        if current_issue_lines:
                            current_issue_lines.append(line)
                    elif in_high_critical_issue and current_issue_lines:
                        current_issue_lines.append(line)
                        # Stop collecting when we hit separator or next issue
                        if line.startswith('--') or line.strip() == '':
                            high_critical_issues.extend(current_issue_lines)
                            current_issue_lines = []
                            in_high_critical_issue = False
                
                # Add last issue if applicable
                if in_high_critical_issue and current_issue_lines:
                    high_critical_issues.extend(current_issue_lines)
                
                if high_critical_issues:
                    filtered_output = '\n'.join(high_critical_issues)
                    self.issues.append(("Bandit", filtered_output))
        except FileNotFoundError:
            self.issues.append(("Bandit", "ERROR: bandit is not installed or not in PATH."))

    def _run_ruff(self):
        print("Running ruff...")
        try:
            # Exclude Jupyter notebooks from Ruff checks (they have different structure)
            result = subprocess.run(
                ['ruff', 'check', self.root_path, '--exclude', '*.ipynb,node_modules,.venv-ci,.tvenv,.venv-configure-tests,.agent-venv,_pt'],
                capture_output=True, text=True
            )
            # Only add Ruff issues if exit code is non-zero (actual errors found)
            if result.returncode != 0 and result.stdout:
                self.issues.append(("Ruff", result.stdout))
            elif result.stdout and 'All checks passed!' not in result.stdout:
                # Also handle cases where ruff outputs warnings but exit code is 0
                self.issues.append(("Ruff", result.stdout))
        except FileNotFoundError:
            self.issues.append(("Ruff", "ERROR: ruff is not installed or not in PATH."))

    def _run_ast_checks(self):
        print("Running AST checks...")
        
        # Support scanning a single file directly
        if os.path.isfile(self.root_path):
            if self.root_path.endswith('.py'):
                self._check_file_path(self.root_path)
            return

        for root, _, files in os.walk(self.root_path):
            for file in files:
                if file.endswith('.py'):
                    path = os.path.join(root, file)
                    # Skip safety checker itself, test files, and build artifacts
                    if ('python-safety-checker.py' in path or
                        '/test_' in path or
                        '/tests/' in path or
                        '/.aws-sam/' in path or
                        '/build/' in path or
                        '/dist/' in path or
                        '/node_modules/' in path or
                        '/.venv/' in path or
                        '/.venv-ci/' in path or
                        '/.tvenv/' in path or
                        '/.venv-configure-tests/' in path or
                        '/.agent-venv/' in path or
                        '/_pt/' in path or
                        '/venv/' in path):
                        continue
                    self._check_file_path(path)

    def _check_file_path(self, path):
        with open(path, 'r') as f:
            try:
                tree = ast.parse(f.read(), filename=path)
                self._check_file(tree, path)
            except SyntaxError as e:
                self.issues.append(("AST", f"ERROR: Could not parse {path}: {e}"))

    def _check_file(self, tree, path):
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id.upper() in ['PASSWORD', 'SECRET', 'API_KEY']:
                        # Check if value is from environment variable (os.getenv, os.environ, etc.)
                        value_is_from_env = False
                        if isinstance(node.value, ast.Call):
                            # Check for os.getenv(), os.environ.get(), etc.
                            if isinstance(node.value.func, ast.Attribute):
                                if node.value.func.attr in ['getenv', 'get'] and isinstance(node.value.func.value, ast.Name) and node.value.func.value.id == 'os':
                                    value_is_from_env = True
                            # Check for os.environ['KEY'] or os.environ.get('KEY')
                            if isinstance(node.value.func, ast.Subscript) and isinstance(node.value.func.value, ast.Attribute):
                                if node.value.func.value.attr == 'environ' and isinstance(node.value.func.value.value, ast.Name) and node.value.func.value.value.id == 'os':
                                    value_is_from_env = True
                        elif isinstance(node.value, ast.Attribute):
                            # Check for os.environ['KEY'] assignments
                            if isinstance(node.value.value, ast.Attribute) and node.value.value.attr == 'environ':
                                value_is_from_env = True
                        
                        # Only flag hardcoded string literals, not environment variable lookups
                        # Handle both Python 3.7 (ast.Str) and Python 3.8+ (ast.Constant)
                        is_string_literal = False
                        if hasattr(ast, 'Constant'):
                            # Python 3.8+
                            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                                is_string_literal = True
                        else:
                            # Python 3.7 and earlier
                            if isinstance(node.value, getattr(ast, 'Str', type(None))):
                                is_string_literal = True
                        
                        if is_string_literal and not value_is_from_env:
                            self.issues.append(("AST", f"Hardcoded credential found in {path} on line {node.lineno}"))
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in ['eval', 'exec']:
                    self.issues.append(("AST", f"Insecure function '{node.func.id}' used in {path} on line {node.lineno}"))
                if isinstance(node.func, ast.Attribute) and node.func.attr in ['load', 'loads'] and isinstance(node.func.value, ast.Name) and node.func.value.id == 'pickle':
                    self.issues.append(("AST", f"Insecure function 'pickle.{node.func.attr}' used in {path} on line {node.lineno}"))
            elif isinstance(node, ast.FunctionDef):
                # Missing docstrings are warnings (non-blocking), not errors
                # Only flag mutable default arguments as errors
                for arg in node.args.defaults:
                    if isinstance(arg, (ast.List, ast.Dict)):
                        self.issues.append(("AST", f"Mutable default argument used in function '{node.name}' in {path} on line {node.lineno}"))
            elif isinstance(node, ast.ClassDef):
                # Missing docstrings are warnings (non-blocking), not errors
                pass

    def _print_summary(self):
        print("\nPython Safety Checker Summary")
        print("=============================")
        if not self.issues:
            print("✓ All checks passed!")
        else:
            for tool, issue in self.issues:
                print(f"\n--- {tool} Issues ---")
                print(issue)
            print(f"\n✗ Found {len(self.issues)} issues.")
            sys.exit(1)

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else '.'
    checker = PythonSafetyChecker(target)
    checker.check()
