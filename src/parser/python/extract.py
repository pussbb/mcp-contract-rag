"""Extract public classes/functions and imports from Python files.

Reads a JSON object {path: source} on stdin, writes {path: {exports, imports}} or
{path: {error}} on stdout. Database access stays in the Node indexer.
"""
import ast
import json
import sys

MAX_DESC = 400
ABC_BASES = {"ABC", "abc.ABC"}
ABSTRACT_DECORATORS = {"abstractmethod", "abc.abstractmethod"}


def describe(node):
    doc = ast.get_docstring(node)
    if not doc:
        return None
    text = " ".join(doc.split())
    return text if len(text) <= MAX_DESC else text[: MAX_DESC - 1] + "…"


def is_abstract_method(fn):
    return any(ast.unparse(d) in ABSTRACT_DECORATORS for d in fn.decorator_list)


def function_signature(fn, indent="", prefix=""):
    kw = "async def" if isinstance(fn, ast.AsyncFunctionDef) else "def"
    returns = f" -> {ast.unparse(fn.returns)}" if fn.returns else ""
    return f"{indent}{prefix}{kw} {fn.name}({ast.unparse(fn.args)}){returns}: ..."


def extract_class(node):
    bases = [ast.unparse(b) for b in node.bases]
    abstract = any(b in ABC_BASES for b in bases)
    lines = []
    for member in node.body:
        if not isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if member.name.startswith("_") and not member.name.startswith("__"):
            continue
        method_abstract = is_abstract_method(member)
        abstract = abstract or method_abstract
        lines.append(function_signature(member, "  ", "abstract " if method_abstract else ""))
    head = f"{'abstract class' if abstract else 'class'} {node.name}"
    if bases:
        head += f"({', '.join(bases)})"
    return {
        "name": node.name,
        "type": "abstract_class" if abstract else "class",
        "signature": "\n".join([f"{head}:", *lines]),
        "description": describe(node),
    }


def extract(source):
    tree = ast.parse(source)
    exports, imports = [], []
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and not node.name.startswith("_"):
            exports.append(extract_class(node))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
            exports.append({
                "name": node.name,
                "type": "function",
                "signature": function_signature(node),
                "description": describe(node),
            })
        elif isinstance(node, ast.Import):
            imports.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            dots = "." * node.level
            if node.module:
                imports.append(dots + node.module)
            else:
                imports.extend(dots + alias.name for alias in node.names)
    imports = [i for i in imports if i.lstrip(".").split(".")[0] not in sys.stdlib_module_names or i.startswith(".")]
    return {"exports": exports, "imports": imports}


def main():
    files = json.load(sys.stdin)
    out = {}
    for path, source in files.items():
        try:
            out[path] = extract(source)
        except SyntaxError as err:
            out[path] = {"error": f"SyntaxError: {err}"}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
