using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;

namespace Kv.WindowsUia.Driver;

internal static class Program
{
    private const int ProtocolVersion = 1;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    [STAThread]
    private static async Task Main()
    {
        Console.InputEncoding = System.Text.Encoding.UTF8;
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            object response;
            try
            {
                var request = JsonSerializer.Deserialize<DriverRequest>(line, JsonOptions)
                    ?? throw new InvalidOperationException("Request body is empty.");
                response = Handle(request);
            }
            catch (Exception error)
            {
                response = new DriverResponse(
                    Id: null,
                    Ok: false,
                    Result: null,
                    Error: new DriverError("INVALID_REQUEST", error.Message, false));
            }

            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response, JsonOptions));
            await Console.Out.FlushAsync();
        }
    }

    private static DriverResponse Handle(DriverRequest request)
    {
        return request.Method switch
        {
            "status" => Success(request.Id, new
            {
                protocolVersion = ProtocolVersion,
                driver = "windows-uia",
                mode = "read-only",
                capabilities = new[] { "list_windows", "observe_foreground", "observe_window" },
            }),
            "observe" => Success(request.Id, Observe(request.Params)),
            _ => new DriverResponse(request.Id, false, null,
                new DriverError("METHOD_NOT_FOUND", $"Unsupported method: {request.Method}", false)),
        };
    }

    private static object Observe(JsonElement parameters)
    {
        var maxWindows = ReadBoundedInt(parameters, "maxWindows", 20, 1, 100);
        var maxElements = ReadBoundedInt(parameters, "maxElements", 250, 1, 2_000);
        var maxDepth = ReadBoundedInt(parameters, "maxDepth", 6, 0, 20);
        var requestedWindow = ReadOptionalLong(parameters, "windowHandle");
        var foregroundHandle = GetForegroundWindow().ToInt64();

        var root = AutomationElement.RootElement;
        var windows = root.FindAll(TreeScope.Children, Condition.TrueCondition)
            .Cast<AutomationElement>()
            .Select(TryMapWindow)
            .Where(window => window is not null)
            .Cast<WindowObservation>()
            .Take(maxWindows)
            .ToArray();

        var targetHandle = requestedWindow ?? foregroundHandle;
        var target = windows.FirstOrDefault(window => window.Handle == targetHandle);
        var elements = target is null
            ? Array.Empty<ElementObservation>()
            : ObserveElements(AutomationElement.FromHandle(new IntPtr(target.Handle)), maxElements, maxDepth);

        return new
        {
            protocolVersion = ProtocolVersion,
            observationId = Guid.NewGuid().ToString(),
            capturedAt = DateTimeOffset.UtcNow,
            driver = "windows-uia",
            foregroundWindowHandle = foregroundHandle,
            windows,
            targetWindow = target,
            elements,
            truncated = elements.Length >= maxElements,
        };
    }

    private static ElementObservation[] ObserveElements(AutomationElement root, int maxElements, int maxDepth)
    {
        var results = new List<ElementObservation>(Math.Min(maxElements, 256));
        var queue = new Queue<(AutomationElement Element, int Depth)>();
        queue.Enqueue((root, 0));

        while (queue.Count > 0 && results.Count < maxElements)
        {
            var (element, depth) = queue.Dequeue();
            if (depth > 0)
            {
                var mapped = TryMapElement(element, depth);
                if (mapped is not null) results.Add(mapped);
            }

            if (depth >= maxDepth) continue;
            AutomationElement? child;
            try { child = TreeWalker.ControlViewWalker.GetFirstChild(element); }
            catch (ElementNotAvailableException) { continue; }

            while (child is not null && results.Count + queue.Count < maxElements * 2)
            {
                queue.Enqueue((child, depth + 1));
                try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
                catch (ElementNotAvailableException) { child = null; }
            }
        }

        return results.ToArray();
    }

    private static WindowObservation? TryMapWindow(AutomationElement element)
    {
        try
        {
            var handle = element.Current.NativeWindowHandle;
            if (handle == 0) return null;
            var bounds = element.Current.BoundingRectangle;
            return new WindowObservation(
                Handle: handle,
                Name: element.Current.Name,
                ClassName: element.Current.ClassName,
                ProcessId: element.Current.ProcessId,
                IsEnabled: element.Current.IsEnabled,
                IsOffscreen: element.Current.IsOffscreen,
                Bounds: RectObservation.From(bounds));
        }
        catch (ElementNotAvailableException) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    private static ElementObservation? TryMapElement(AutomationElement element, int depth)
    {
        try
        {
            var current = element.Current;
            var runtimeId = element.GetRuntimeId();
            return new ElementObservation(
                Ref: runtimeId is null ? null : $"uia:{string.Join('.', runtimeId)}",
                Depth: depth,
                Name: current.Name,
                AutomationId: current.AutomationId,
                ClassName: current.ClassName,
                ControlType: current.ControlType?.ProgrammaticName,
                IsEnabled: current.IsEnabled,
                IsOffscreen: current.IsOffscreen,
                IsKeyboardFocusable: current.IsKeyboardFocusable,
                Bounds: RectObservation.From(current.BoundingRectangle));
        }
        catch (ElementNotAvailableException) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    private static DriverResponse Success(string? id, object result) => new(id, true, result, null);

    private static int ReadBoundedInt(JsonElement parameters, string name, int fallback, int min, int max)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty(name, out var value) ||
            !value.TryGetInt32(out var parsed)) return fallback;
        return Math.Clamp(parsed, min, max);
    }

    private static long? ReadOptionalLong(JsonElement parameters, string name)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty(name, out var value) ||
            !value.TryGetInt64(out var parsed)) return null;
        return parsed;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
}

internal sealed record DriverRequest(string? Id, string Method, JsonElement Params);
internal sealed record DriverResponse(string? Id, bool Ok, object? Result, DriverError? Error);
internal sealed record DriverError(string Code, string Message, bool Retryable);
internal sealed record WindowObservation(long Handle, string Name, string ClassName, int ProcessId, bool IsEnabled, bool IsOffscreen, RectObservation Bounds);
internal sealed record ElementObservation(string? Ref, int Depth, string Name, string AutomationId, string ClassName, string? ControlType, bool IsEnabled, bool IsOffscreen, bool IsKeyboardFocusable, RectObservation Bounds);
internal sealed record RectObservation(double X, double Y, double Width, double Height)
{
    public static RectObservation From(System.Windows.Rect rect) => new(rect.X, rect.Y, rect.Width, rect.Height);
}
