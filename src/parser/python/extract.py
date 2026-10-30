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
    # Build args with type annotations
    args_parts = []
    for arg in fn.args.args:
        arg_str = arg.arg
        if arg.annotation:
            arg_str += f": {ast.unparse(arg.annotation)}"
        args_parts.append(arg_str)
    # Handle *args
    if fn.args.vararg:
        vararg_str = f"*{fn.args.vararg.arg}"
        if fn.args.vararg.annotation:
            vararg_str += f": {ast.unparse(fn.args.vararg.annotation)}"
        args_parts.append(vararg_str)
    # Handle **kwargs
    if fn.args.kwarg:
        kwarg_str = f"**{fn.args.kwarg.arg}"
        if fn.args.kwarg.annotation:
            kwarg_str += f": {ast.unparse(fn.args.kwarg.annotation)}"
        args_parts.append(kwarg_str)
    # Handle defaults (simplified - just show the names for the signature)
    args = ", ".join(args_parts)
    return f"{indent}{prefix}{kw} {fn.name}({args}){returns}: ..."


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


def extract_imports(tree):
    """Extract all imports from the AST, including those inside functions."""
    imports = []

    def visit(node):
        if isinstance(node, ast.Import):
            imports.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            dots = "." * node.level
            if node.module:
                imports.append(dots + node.module)
            else:
                imports.extend(dots + alias.name for alias in node.names)
        # Recursively visit child nodes to catch imports inside functions
        for child in ast.iter_child_nodes(node):
            visit(child)

    visit(tree)
    return [i for i in imports if i.lstrip(".").split(".")[0] not in sys.stdlib_module_names or i.startswith(".")]


def extract(source):
    tree = ast.parse(source)
    exports, imports = [], []

    # Check for __all__ to determine explicitly exported names
    all_names = None
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "__all__":
                    if isinstance(node.value, (ast.List, ast.Tuple)):
                        all_names = set()
                        for elt in node.value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                all_names.add(elt.value)

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
        elif isinstance(node, ast.Assign):
            # Extract module-level constants (UPPER_CASE names)
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.isupper() and not target.id.startswith("_"):
                    const_value = ast.unparse(node.value)
                    # Truncate long values
                    if len(const_value) > 200:
                        const_value = const_value[:197] + "..."
                    exports.append({
                        "name": target.id,
                        "type": "const",
                        "signature": f"{target.id} = {const_value}",
                        "description": None,
                    })
                # Extract type aliases (assignments with type annotations)
                elif target.annotation and not target.id.startswith("_"):
                    type_annotation = ast.unparse(target.annotation)
                    type_value = ast.unparse(node.value)
                    exports.append({
                        "name": target.id,
                        "type": "type",
                        "signature": f"{target.id}: {type_annotation} = {type_value}",
                        "description": None,
                    })
        # Extract type aliases from AnnAssign (PEP 526)
        elif isinstance(node, ast.AnnAssign) and not node.target.id.startswith("_"):
            type_annotation = ast.unparse(node.annotation)
            value_str = f" = {ast.unparse(node.value)}" if node.value else ""
            exports.append({
                "name": node.target.id,
                "type": "type",
                "signature": f"{node.target.id}: {type_annotation}{value_str}",
                "description": None,
            })

    # Filter exports by __all__ if present
    if all_names is not None:
        exports = [e for e in exports if e["name"] in all_names]

    imports = extract_imports(tree)
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
