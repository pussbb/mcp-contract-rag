using System.Text.Json;
using System.Text.Json.Serialization;

// stdin: {"path": "source", ...}  stdout: {"path": {exports, imports, references} | {error}, ...}
var input = JsonSerializer.Deserialize<Dictionary<string, string>>(Console.In.ReadToEnd()) ?? new();
var output = new Dictionary<string, object>();
foreach (var (path, source) in input)
{
    try { output[path] = Analyzer.Analyze(source); }
    catch (Exception e) { output[path] = new ErrorResult(e.Message); }
}

var options = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
};
Console.Out.Write(JsonSerializer.Serialize(output, options));

record ErrorResult(string Error);
record ExportInfo(string Name, string Type, string Signature, string? Description, string Namespace);
record AnalysisResult(List<ExportInfo> Exports, List<string> Imports, List<string> References);
