#!/usr/bin/env python3
"""
audit-code-integrity.py — Ona Platform Manual Code Integrity Auditor

Audits repository files for:
1. Lifecycle Symmetry & Teardown Parity (Shell/Python resources)
2. Behavioral Test Authenticity (Mock Theater Detection)
3. Architectural Naming & Contract Alignment
4. Error Handling & Hygiene (Swallowed Exceptions & Root Clutter)
5. DRY Invariants & Duplicative Functions

Outputs formatted terminal reports and saves structured JSON logs to .review/<M-D-YYYY-XXX>-audit-report.json
"""

import argparse
import ast
import datetime
import json
import os
import re
import sys

WORKSPACE_ROOT = os.getcwd()


class CodeIntegrityAuditor:
    def __init__(self, target_path=None, verbose=False, output_dir=None):
        self.target_path = os.path.abspath(target_path or WORKSPACE_ROOT)
        self.verbose = verbose
        base_dir = os.path.dirname(self.target_path) if os.path.isfile(self.target_path) else self.target_path
        self.output_dir = output_dir or os.path.join(base_dir, ".review")
        self.findings = {
            "lifecycle_parity": [],
            "behavioral_tests": [],
            "architectural_naming": [],
            "error_handling": [],
            "dry_violations": [],
        }
        self.authenticity_stats = {
            "tier_1_live": 0,
            "tier_2_contract": 0,
            "tier_3_theater": 0,
            "total_test_functions": 0,
        }

    def run(self):
        if os.path.isfile(self.target_path):
            files_to_scan = [self.target_path]
            base_dir = os.path.dirname(self.target_path)
        else:
            files_to_scan = self._get_files_to_scan(self.target_path)
            base_dir = self.target_path

        for file_path in files_to_scan:
            rel_path = os.path.relpath(file_path, base_dir) if file_path.startswith(base_dir) else file_path
            if file_path.endswith(".sh"):
                self._audit_shell_file(file_path, rel_path)
            elif file_path.endswith(".py"):
                self._audit_python_file(file_path, rel_path)

        self._audit_duplicative_functions(files_to_scan, base_dir)

        report_path = self._save_json_report()
        return report_path

    def _get_files_to_scan(self, root_dir):
        files = []
        skip_dirs = {"node_modules", "venv", ".venv", "/tmp/"}
        for dirpath, dirnames, filenames in os.walk(root_dir):
            dirnames[:] = [d for d in dirnames if d not in skip_dirs and not d.startswith(".")]
            for f in filenames:
                if f.endswith(".sh") or f.endswith(".py"):
                    files.append(os.path.join(dirpath, f))
        return sorted(files)

    def _audit_shell_file(self, file_path, rel_path):
        try:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
                lines = content.splitlines()
        except Exception:
            return

        has_trap = "trap " in content or "cleanup()" in content
        
        # 1. Resource Allocations vs Teardown Parity
        creations = [
            ("docker buildx create", "docker buildx rm", "buildx builder creation"),
            ("docker context create", "docker context rm", "docker context creation"),
            ("aws ec2 run-instances", "aws ec2 terminate-instances", "EC2 instance launch"),
            ("aws ec2 authorize-security-group-ingress", "aws ec2 revoke-security-group-ingress", "security group ingress rule"),
        ]

        for create_cmd, remove_cmd, resource_desc in creations:
            if create_cmd in content:
                if not has_trap or remove_cmd not in content:
                    self.findings["lifecycle_parity"].append({
                        "file": rel_path,
                        "severity": "FAIL",
                        "rule": "LIFECYCLE_ASYMMETRY",
                        "message": f"Script contains '{create_cmd}' ({resource_desc}) but lacks matching '{remove_cmd}' in cleanup trap.",
                    })

        # 2. Forced Teardown Checks (--force or -f)
        for idx, line in enumerate(lines, 1):
            if "docker buildx rm" in line and "--force" not in line and "-f" not in line:
                self.findings["lifecycle_parity"].append({
                    "file": rel_path,
                    "line": idx,
                    "severity": "FAIL",
                    "rule": "BLOCKING_TEARDOWN",
                    "message": "Call to 'docker buildx rm' lacks '--force' / '-f' flag, which can hang on dead SSH hosts.",
                })
            if "docker context rm" in line and "2>/dev/null" not in line and "|| true" not in line:
                self.findings["lifecycle_parity"].append({
                    "file": rel_path,
                    "line": idx,
                    "severity": "WARN",
                    "rule": "UNGUARDED_CONTEXT_RM",
                    "message": "Call to 'docker context rm' lacks error guard ('2>/dev/null || true').",
                })

        # 3. Global Ambient State Leak Check
        if "docker buildx use" in content and "docker buildx use default" not in content:
            self.findings["lifecycle_parity"].append({
                "file": rel_path,
                "severity": "WARN",
                "rule": "AMBIENT_STATE_LEAK",
                "message": "Script modifies active buildx builder ('docker buildx use') without restoring default builder in cleanup.",
            })

    def _audit_python_file(self, file_path, rel_path):
        try:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            tree = ast.parse(content, filename=file_path)
        except Exception:
            return

        is_test_file = (
            "test_" in rel_path
            or "_test" in rel_path
            or "tests/" in rel_path
            or re.search(r"^\s*def test_", content, re.MULTILINE) is not None
        )

        # Scan AST nodes
        for node in ast.walk(tree):
            # 1. Behavioral Test Authenticity (Mock Theater Detection)
            if is_test_file and isinstance(node, ast.FunctionDef) and node.name.startswith("test_"):
                self._check_mock_theater(node, rel_path, content)

            # 2. Architectural Naming Verification
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and "LAMBDA" in target.id.upper():
                        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                            val = node.value.value
                            if val and not val.startswith("ona-") and not val.startswith("/ona/") and not val.startswith("/aws/lambda/"):
                                self.findings["architectural_naming"].append({
                                    "file": rel_path,
                                    "line": node.lineno,
                                    "severity": "FAIL",
                                    "rule": "INVALID_LAMBDA_NAME",
                                    "message": f"Lambda function variable '{target.id}' value '{val}' violates 'ona-{{service}}-{{stage}}' naming invariant.",
                                })

            # 3. Swallowed Error Exceptions
            if isinstance(node, ast.ExceptHandler):
                if len(node.body) == 1 and isinstance(node.body[0], ast.Pass):
                    self.findings["error_handling"].append({
                        "file": rel_path,
                        "line": node.lineno,
                        "severity": "WARN",
                        "rule": "SWALLOWED_EXCEPTION",
                        "message": "Exception handler silently swallows errors with bare 'pass' without logging.",
                    })

    def _check_mock_theater(self, func_node, rel_path, content):
        self.authenticity_stats["total_test_functions"] += 1
        func_name = func_node.name
        target_stem = func_name.replace("test_", "")

        allowed_external_prefixes = (
            "boto3", "botocore", "requests", "urllib", "sys", "os", "subprocess",
            "pgvector", "pymysql", "redis", "psycopg2", "aiohttp", "fitz", "pdfplumber",
            "builtins", "datetime", "time", "json", "math", "numpy", "pandas", "sklearn", "scipy"
        )

        patched_targets = []
        has_substantive_assert = False
        has_any_assert = False
        is_internal_mocked = False
        is_live_aws = False

        func_body_str = ast.unparse(func_node) if hasattr(ast, "unparse") else ""
        if any(term in func_body_str for term in ["boto3.client", "boto3.resource", "requests.get", "requests.post", "urllib.request", "aws lambda", "aws e2e"]):
            is_live_aws = True

        # Walk nodes inside test function definition
        for subnode in ast.walk(func_node):
            # Inspect @patch(...) or with patch(...) or mocker.patch(...)
            if isinstance(subnode, ast.Call):
                func_str = ast.unparse(subnode.func) if hasattr(ast, "unparse") else ""
                if "patch" in func_str and subnode.args:
                    arg0 = subnode.args[0]
                    if isinstance(arg0, ast.Constant) and isinstance(arg0.value, str):
                        target_str = arg0.value
                        patched_targets.append(target_str)

                        # Check if internal service function is mocked
                        if ("services." in target_str or "app." in target_str or target_str.startswith("app")) and not any(target_str.startswith(p) for p in allowed_external_prefixes):
                            is_internal_mocked = True
                            self.findings["behavioral_tests"].append({
                                "file": rel_path,
                                "line": subnode.lineno,
                                "severity": "WARN",
                                "rule": "INTERNAL_FUNCTION_MOCKED",
                                "message": f"Test '{func_name}' patches internal function/module '{target_str}'. Behavioral tests must call internal service logic directly and only mock external boundaries.",
                            })
                        elif target_stem and (target_stem in target_str or target_str.endswith(f".{target_stem}")):
                            is_internal_mocked = True
                            self.findings["behavioral_tests"].append({
                                "file": rel_path,
                                "line": subnode.lineno,
                                "severity": "WARN",
                                "rule": "MOCK_THEATER_TARGET_MOCKED",
                                "message": f"Test '{func_name}' mocks the primary function under test ('{target_stem}'). Behavioral tests must call the actual target function directly.",
                            })

            # Inspect Assert statements
            if isinstance(subnode, ast.Assert):
                has_any_assert = True
                assert_str = ast.unparse(subnode.test) if hasattr(ast, "unparse") else ""
                # Substantive assertions check equality, subscripting, in-comparisons, or value bounds
                if any(op in assert_str for op in ["==", "!=", " in ", ">", "<", "[", "]"]):
                    has_substantive_assert = True

            # Inspect mock assertion calls like mock.assert_called_once()
            if isinstance(subnode, ast.Expr) and isinstance(subnode.value, ast.Call):
                call_str = ast.unparse(subnode.value.func) if hasattr(ast, "unparse") else ""
                if "assert_called" in call_str:
                    has_any_assert = True

        # Flag tests with zero substantive outcome assertions (Assertion Theater)
        if not has_substantive_assert:
            self.findings["behavioral_tests"].append({
                "file": rel_path,
                "line": func_node.lineno,
                "severity": "WARN",
                "rule": "ASSERTION_THEATER",
                "message": f"Test '{func_name}' has no substantive outcome value assertions (e.g. data contract keys, non-zero ranges, schema checks). Testing mocks without outcome checks is Mock Theater.",
            })

        # Classify Tier
        if is_live_aws:
            self.authenticity_stats["tier_1_live"] += 1
        elif has_substantive_assert and not is_internal_mocked:
            self.authenticity_stats["tier_2_contract"] += 1
        else:
            self.authenticity_stats["tier_3_theater"] += 1

    def _audit_duplicative_functions(self, files_to_scan, base_dir):
        ignored_names = {
            "main", "handler", "lambda_handler", "cleanup", "__init__", "setUp", "tearDown",
            "run", "execute", "cleanup_on_failure", "require_cmd", "app"
        }

        func_names_seen = {}
        ast_hashes_seen = {}

        for file_path in files_to_scan:
            if not file_path.endswith(".py"):
                continue

            rel_path = os.path.relpath(file_path, base_dir) if file_path.startswith(base_dir) else file_path

            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                tree = ast.parse(content)
            except Exception:
                continue

            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef):
                    fname = node.name
                    if fname.startswith("_") or fname in ignored_names or fname.startswith("test_"):
                        continue

                    # 1. Duplicate Function Name Check
                    if fname in func_names_seen:
                        first_rel, first_line = func_names_seen[fname]
                        if first_rel != rel_path:
                            self.findings["dry_violations"].append({
                                "file": rel_path,
                                "line": node.lineno,
                                "severity": "WARN",
                                "rule": "DUPLICATE_FUNCTION_NAME",
                                "message": f"Function '{fname}' is duplicated across files (first defined in '{first_rel}:L{first_line}'). Share logic via central package import instead of repeating function definitions.",
                            })
                    else:
                        func_names_seen[fname] = (rel_path, node.lineno)

                    # 2. AST Structural Code Clone Check (>= 2 statements)
                    if len(node.body) >= 2:
                        try:
                            node_copy = ast.parse(ast.unparse(node)) if hasattr(ast, "unparse") else node
                            ast_str = ast.dump(node_copy, annotate_fields=False, include_attributes=False)
                            norm_ast = re.sub(r"'[a-zA-Z0-9_]+'", "'VAR'", ast_str)

                            if norm_ast in ast_hashes_seen:
                                first_name, first_rel, first_line = ast_hashes_seen[norm_ast]
                                if first_rel != rel_path or first_name != fname:
                                    self.findings["dry_violations"].append({
                                        "file": rel_path,
                                        "line": node.lineno,
                                        "severity": "WARN",
                                        "rule": "DUPLICATE_FUNCTION_LOGIC",
                                        "message": f"Function '{fname}' has identical AST code logic structure as '{first_name}' in '{first_rel}:L{first_line}'. Refactor into shared module.",
                                    })
                            else:
                                ast_hashes_seen[norm_ast] = (fname, rel_path, node.lineno)
                        except Exception:
                            pass

    def _save_json_report(self):
        os.makedirs(self.output_dir, exist_ok=True)
        now = datetime.datetime.now()
        date_str = f"{now.month}-{now.day}-{now.year}"
        
        # Calculate next sequence number for today
        existing = [f for f in os.listdir(self.output_dir) if f.startswith(date_str) and f.endswith("-audit-report.json")]
        seq = len(existing) + 1
        filename = f"{date_str}-{seq:03d}-audit-report.json"
        report_file = os.path.join(self.output_dir, filename)

        total_fails = sum(1 for cat in self.findings.values() for item in cat if item.get("severity") == "FAIL")
        total_warns = sum(1 for cat in self.findings.values() for item in cat if item.get("severity") == "WARN")

        payload = {
            "timestamp": now.isoformat(),
            "target": self.target_path,
            "summary": {
                "total_failures": total_fails,
                "total_warnings": total_warns,
                "status": "FAIL" if total_fails > 0 else "PASS",
                "authenticity_stats": self.authenticity_stats,
            },
            "findings": self.findings,
        }

        with open(report_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)

        return report_file


def print_formatted_summary(auditor, report_path):
    print("=" * 80)
    print("                    ONA PLATFORM CODE INTEGRITY AUDIT REPORT                     ")
    print("=" * 80)

    # Print Authenticity Breakdown Table
    stats = auditor.authenticity_stats
    total_tests = stats["total_test_functions"]
    if total_tests > 0:
        t1_pct = (stats["tier_1_live"] / total_tests) * 100
        t2_pct = (stats["tier_2_contract"] / total_tests) * 100
        t3_pct = (stats["tier_3_theater"] / total_tests) * 100
        print("\nTEST SUITE AUTHENTICITY CLASSIFICATION:")
        print(f"  Tier 1 (Live AWS / E2E Integration)  : {stats['tier_1_live']:3d} tests ({t1_pct:5.1f}%)  [GOLD STANDARD]")
        print(f"  Tier 2 (Contract-Enforced Behavioral): {stats['tier_2_contract']:3d} tests ({t2_pct:5.1f}%)  [VALID LOGIC]")
        print(f"  Tier 3 (Mock Theater / Superficial)  : {stats['tier_3_theater']:3d} tests ({t3_pct:5.1f}%)  [DECEPTIVE THEATER]")
        print("-" * 80)

    total_fails = 0
    total_warns = 0

    category_titles = {
        "lifecycle_parity": "Lifecycle Parity & Resource Teardown",
        "behavioral_tests": "Behavioral Test Authenticity (Anti-Mock Theater)",
        "architectural_naming": "Architectural Naming & Contract Invariants",
        "error_handling": "Error Handling & Exception Hygiene",
        "dry_violations": "DRY Invariants & Duplicative Functions",
    }

    for cat_key, items in auditor.findings.items():
        title = category_titles.get(cat_key, cat_key)
        fails = [i for i in items if i.get("severity") == "FAIL"]
        warns = [i for i in items if i.get("severity") == "WARN"]
        total_fails += len(fails)
        total_warns += len(warns)

        if not items:
            print(f"[PASS] {title}")
        else:
            status_badge = "[FAIL]" if fails else "[WARN]"
            print(f"{status_badge} {title} ({len(fails)} Failures, {len(warns)} Warnings)")
            for item in items:
                line_info = f":L{item['line']}" if "line" in item else ""
                sev = f"[{item['severity']}]"
                print(f"  • {item['file']}{line_info} {sev} {item['message']}")
        print()

    print("=" * 80)
    summary_status = "FAIL" if total_fails > 0 else "PASS"
    print(f"OVERALL STATUS: {summary_status} ({total_fails} Failures, {total_warns} Warnings)")
    print(f"Detailed audit log saved to: {report_path}")
    print("=" * 80)
    return total_fails


def main():
    parser = argparse.ArgumentParser(description="Ona Platform Manual Code Integrity Auditor")
    parser.add_argument("--target", default=None, help="Target file or directory to scan (defaults to repository root)")
    parser.add_argument("--verbose", action="store_true", help="Print verbose output")
    parser.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    parser.add_argument("--output-dir", default=None, help="Directory to save JSON report (defaults to .review/)")

    args = parser.parse_args()

    auditor = CodeIntegrityAuditor(target_path=args.target, verbose=args.verbose, output_dir=args.output_dir)
    report_path = auditor.run()

    if args.format == "json":
        with open(report_path, "r") as f:
            print(f.read())
        total_fails = sum(1 for cat in auditor.findings.values() for item in cat if item.get("severity") == "FAIL")
        sys.exit(1 if total_fails > 0 else 0)

    fails = print_formatted_summary(auditor, report_path)
    sys.exit(1 if fails > 0 else 0)


if __name__ == "__main__":
    main()
