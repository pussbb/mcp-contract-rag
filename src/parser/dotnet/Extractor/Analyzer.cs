using System.Net;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

/// <summary>Extracts top-level type contracts (no bodies) from one C# source file.</summary>
static class Analyzer
{
    const int MaxSignature = 1200;
    const int MaxDescription = 400;
    const int MaxMembers = 40;

    public static AnalysisResult Analyze(string source)
    {
        var root = CSharpSyntaxTree.ParseText(source).GetCompilationUnitRoot();
        var exports = new List<ExportInfo>();
        var seen = new HashSet<string>();

        void Walk(SyntaxList<MemberDeclarationSyntax> members, string ns)
        {
            foreach (var member in members)
            {
                switch (member)
                {
                    case BaseNamespaceDeclarationSyntax n:
                        Walk(n.Members, ns.Length == 0 ? n.Name.ToString() : ns + "." + n.Name);
                        break;
                    case BaseTypeDeclarationSyntax t when TopLevelVisible(t.Modifiers):
                        Add(t.Identifier.Text, TypeKind(t), TypeSignature(t, source), t, t.AttributeLists, ns);
                        break;
                    case DelegateDeclarationSyntax d when TopLevelVisible(d.Modifiers):
                        Add(d.Identifier.Text, "delegate", Truncate(Slice(source, StartOf(d), d.Span.End).TrimEnd(';')), d, d.AttributeLists, ns);
                        break;
                }
            }
        }

        void Add(string name, string type, string signature, SyntaxNode node, SyntaxList<AttributeListSyntax> attrs, string ns)
        {
            if (!seen.Add(name)) return;
            var description = Doc(node);
            var obsolete = attrs.SelectMany(a => a.Attributes).Any(a => a.Name.ToString() is "Obsolete" or "ObsoleteAttribute" or "System.Obsolete");
            if (obsolete) description = ("[deprecated] " + description).Trim();
            exports.Add(new ExportInfo(name, type, signature, description, ns));
        }

        Walk(root.Members, "");

        var imports = root.DescendantNodes().OfType<UsingDirectiveSyntax>()
            .Where(u => u.StaticKeyword.IsKind(SyntaxKind.None) && u.Name is not null)
            .Select(u => u.Name!.ToString()).Distinct().ToList();

        var references = new HashSet<string>();
        foreach (var name in root.DescendantNodes().OfType<SimpleNameSyntax>())
        {
            references.Add(name.Identifier.Text);
            if (name.Parent is AttributeSyntax) references.Add(name.Identifier.Text + "Attribute");
        }
        return new AnalysisResult(exports, imports, references.ToList());
    }

    static bool TopLevelVisible(SyntaxTokenList mods) => !mods.Any(m => m.Text is "private" or "file");

    static string TypeKind(BaseTypeDeclarationSyntax t) => t switch
    {
        ClassDeclarationSyntax c => c.Modifiers.Any(m => m.Text == "abstract") ? "abstract_class" : "class",
        InterfaceDeclarationSyntax => "interface",
        StructDeclarationSyntax => "struct",
        RecordDeclarationSyntax => "record",
        EnumDeclarationSyntax => "enum",
        _ => "class",
    };

    static string TypeSignature(BaseTypeDeclarationSyntax t, string source)
    {
        var start = StartOf(t);
        if (t is EnumDeclarationSyntax e)
        {
            var names = string.Join(", ", e.Members.Take(MaxMembers).Select(m => m.Identifier.Text));
            return Truncate($"{Slice(source, start, e.OpenBraceToken.SpanStart)} {{ {names} }}");
        }
        var td = (TypeDeclarationSyntax)t;
        var hasBody = !td.OpenBraceToken.IsKind(SyntaxKind.None) && !td.OpenBraceToken.IsMissing;
        var header = Slice(source, start, hasBody ? td.OpenBraceToken.SpanStart : td.Span.End).TrimEnd(';').TrimEnd();
        if (!hasBody) return Truncate(header);

        var inInterface = td is InterfaceDeclarationSyntax;
        var lines = td.Members
            .Select(m => MemberSignature(m, source, inInterface))
            .Where(s => s is not null)
            .Take(MaxMembers)
            .Select(s => "  " + (s!.EndsWith("}") ? s : s + ";"));
        return Truncate($"{header} {{\n{string.Join("\n", lines)}\n}}");
    }

    static string? MemberSignature(MemberDeclarationSyntax m, string source, bool inInterface)
    {
        var mods = m.Modifiers.Select(x => x.Text).ToHashSet();
        var visible = inInterface ? !mods.Contains("private") : mods.Contains("public") || mods.Contains("protected");
        if (!visible) return null;
        var start = StartOf(m);

        switch (m)
        {
            case MethodDeclarationSyntax x when x.ExplicitInterfaceSpecifier is null:
                return Slice(source, start, EndBefore(x, x.Body, x.ExpressionBody)).TrimEnd(';').TrimEnd();
            case ConstructorDeclarationSyntax x:
                return Slice(source, start, EndBefore(x, x.Initializer, x.Body, x.ExpressionBody)).TrimEnd(';').TrimEnd();
            case PropertyDeclarationSyntax x when x.ExplicitInterfaceSpecifier is null:
                return Slice(source, start, EndBefore(x, x.AccessorList, x.ExpressionBody, x.Initializer)) + " " + Accessors(x.AccessorList);
            case IndexerDeclarationSyntax x when x.ExplicitInterfaceSpecifier is null:
                return Slice(source, start, EndBefore(x, x.AccessorList, x.ExpressionBody)) + " " + Accessors(x.AccessorList);
            case FieldDeclarationSyntax x:
                return Slice(source, start, x.Declaration.Type.Span.End) + " " + string.Join(", ", x.Declaration.Variables.Select(v => v.Identifier.Text));
            case EventFieldDeclarationSyntax x:
                return Slice(source, start, x.Declaration.Type.Span.End) + " " + string.Join(", ", x.Declaration.Variables.Select(v => v.Identifier.Text));
            case EventDeclarationSyntax x when x.ExplicitInterfaceSpecifier is null:
                return Slice(source, start, EndBefore(x, x.AccessorList));
            default:
                return null;
        }
    }

    static string Accessors(AccessorListSyntax? list)
    {
        if (list is null) return "{ get; }";
        var parts = list.Accessors.Select(a => string.Join(" ", a.Modifiers.Select(m => m.Text).Append(a.Keyword.Text)) + ";");
        return "{ " + string.Join(" ", parts) + " }";
    }

    static int EndBefore(SyntaxNode node, params SyntaxNode?[] stops)
    {
        var starts = stops.Where(s => s is not null).Select(s => s!.SpanStart).ToList();
        return starts.Count > 0 ? starts.Min() : node.Span.End;
    }

    /// <summary>Start of the declaration after its attribute lists.</summary>
    static int StartOf(MemberDeclarationSyntax m) =>
        m.AttributeLists.Count > 0 ? m.AttributeLists.Last().Span.End : m.Span.Start;

    static string Slice(string source, int start, int end) =>
        Regex.Replace(source.Substring(start, Math.Max(0, end - start)), @"\s+", " ").Trim();

    static string Truncate(string s, int max = MaxSignature) => s.Length > max ? s[..(max - 1)] + "…" : s;

    static string? Doc(SyntaxNode node)
    {
        var trivia = node.GetLeadingTrivia().LastOrDefault(t =>
            t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) || t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia));
        if (trivia == default || trivia.GetStructure() is not DocumentationCommentTriviaSyntax doc) return null;
        var summary = doc.ChildNodes().OfType<XmlElementSyntax>().FirstOrDefault(e => e.StartTag.Name.ToString() == "summary");
        if (summary is null) return null;

        var text = summary.Content.ToString();
        text = Regex.Replace(text, "<(?:see|paramref|typeparamref)\\s+(?:cref|name|langword)=\"([^\"]+)\"\\s*/>", "$1");
        text = Regex.Replace(text, "<[^>]+>", " ").Replace("///", " ");
        text = Regex.Replace(WebUtility.HtmlDecode(text), @"\s+", " ").Trim();
        return text.Length == 0 ? null : Truncate(text, MaxDescription);
    }
}
