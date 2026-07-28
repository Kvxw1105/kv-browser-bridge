using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;

namespace Kv.WindowsUia.Driver;

internal static class Program
{
    private const int ProtocolVersion = 1;
    private const int SwRestore = 9;
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
            DriverResponse response;
            try
            {
                var request = JsonSerializer.Deserialize<DriverRequest>(line, JsonOptions)
                    ?? throw new DriverFaultException("INVALID_REQUEST", "Request body is empty.", false);
                response = Handle(request);
            }
            catch (DriverFaultException error)
            {
                response = new DriverResponse(null, false, null,
                    new DriverError(error.Code, error.Message, error.Retryable));
            }
            catch (Exception error)
            {
                response = new DriverResponse(null, false, null,
                    new DriverError("INVALID_REQUEST", error.Message, false));
            }

            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response, JsonOptions));
            await Console.Out.FlushAsync();
        }
    }

    private static DriverResponse Handle(DriverRequest request)
    {
        try
        {
            return request.Method switch
            {
                "status" => Success(request.Id, new
                {
                    protocolVersion = ProtocolVersion,
                    driver = "windows-uia",
                    mode = "controlled-write",
                    capabilities = new[]
                    {
                        "list_windows", "observe_foreground", "observe_window",
                        "focus_window", "invoke_ref", "set_value_ref",
                    },
                }),
                "observe" => Success(request.Id, Observe(request.Params)),
                "focus_window" => Success(request.Id, FocusWindow(request.Params)),
                "invoke_ref" => Success(request.Id, InvokeRef(request.Params)),
                "set_value_ref" => Success(request.Id, SetValueRef(request.Params)),
                _ => throw new DriverFaultException("METHOD_NOT_FOUND", $"Unsupported method: {request.Method}", false),
            };
        }
        catch (DriverFaultException error)
        {
            return new DriverResponse(request.Id, false, null,
                new DriverError(error.Code, error.Message, error.Retryable));
        }
        catch (ElementNotAvailableException error)
        {
            return new DriverResponse(request.Id, false, null,
                new DriverError("ELEMENT_NOT_AVAILABLE", error.Message, true));
        }
        catch (InvalidOperationException error)
        {
            return new DriverResponse(request.Id, false, null,
                new DriverError("UIA_OPERATION_FAILED", error.Message, true));
        }
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
        var target = windows.FirstOrDefault(window => window.Handle == targetHandle)
            ?? TryMapWindowFromHandle(targetHandle);
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

    private static object FocusWindow(JsonElement parameters)
    {
        var windowHandle = ReadRequiredLong(parameters, "windowHandle");
        var handle = new IntPtr(windowHandle);
        if (!IsWindow(handle))
            throw new DriverFaultException("WINDOW_NOT_FOUND", $"Window handle {windowHandle} does not exist.", true);

        _ = ShowWindowAsync(handle, SwRestore);
        if (!SetForegroundWindow(handle))
            throw new DriverFaultException("FOCUS_REJECTED", $"Windows rejected foreground activation for {windowHandle}.", true);

        Thread.Sleep(75);
        var foregroundWindowHandle = GetForegroundWindow().ToInt64();
        if (foregroundWindowHandle != windowHandle)
            throw new DriverFaultException("FOCUS_NOT_CONFIRMED", $"Foreground window is {foregroundWindowHandle}, expected {windowHandle}.", true);

        return new { action = "focus_window", windowHandle, foregroundWindowHandle };
    }

    private static object InvokeRef(JsonElement parameters)
    {
        var targetRef = ReadRequiredString(parameters, "targetRef");
        var windowHandle = ReadOptionalLong(parameters, "windowHandle") ?? GetForegroundWindow().ToInt64();
        var element = ResolveElement(windowHandle, targetRef, parameters);
        if (!element.Current.IsEnabled)
            throw new DriverFaultException("ELEMENT_DISABLED", $"Element {targetRef} is disabled.", true);
        if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out var rawPattern) || rawPattern is not InvokePattern invokePattern)
            throw new DriverFaultException("PATTERN_UNAVAILABLE", $"Element {targetRef} does not expose InvokePattern.", false);

        invokePattern.Invoke();
        return new
        {
            action = "invoke_ref",
            windowHandle,
            targetRef,
            element = TryMapElement(element, 0),
        };
    }

    private static object SetValueRef(JsonElement parameters)
    {
        var targetRef = ReadRequiredString(parameters, "targetRef");
        var value = ReadRequiredString(parameters, "value", allowEmpty: true);
        var windowHandle = ReadOptionalLong(parameters, "windowHandle") ?? GetForegroundWindow().ToInt64();
        var element = ResolveElement(windowHandle, targetRef, parameters);
        if (!element.Current.IsEnabled)
            throw new DriverFaultException("ELEMENT_DISABLED", $"Element {targetRef} is disabled.", true);
        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var rawPattern) || rawPattern is not ValuePattern valuePattern)
            throw new DriverFaultException("PATTERN_UNAVAILABLE", $"Element {targetRef} does not expose ValuePattern.", false);
        if (valuePattern.Current.IsReadOnly)
            throw new DriverFaultException("ELEMENT_READ_ONLY", $"Element {targetRef} is read-only.", false);

        valuePattern.SetValue(value);
        var currentValue = valuePattern.Current.Value;
        return new
        {
            action = "set_value_ref",
            windowHandle,
            targetRef,
            valueSet = currentValue == value,
            currentValue,
            element = TryMapElement(element, 0),
        };
    }

    private static AutomationElement ResolveElement(long windowHandle, string targetRef, JsonElement parameters)
    {
        var handle = new IntPtr(windowHandle);
        if (!IsWindow(handle))
            throw new DriverFaultException("WINDOW_NOT_FOUND", $"Window handle {windowHandle} does not exist.", true);
        var maxElements = ReadBoundedInt(parameters, "maxSearchElements", 2_000, 1, 10_000);
        var maxDepth = ReadBoundedInt(parameters, "maxSearchDepth", 20, 0, 50);
        var root = AutomationElement.FromHandle(handle);
        return FindElementByRef(root, targetRef, maxElements, maxDepth)
            ?? throw new DriverFaultException("ELEMENT_NOT_FOUND", $"Could not relocate {targetRef} in window {windowHandle}.", true);
    }

    private static AutomationElement? FindElementByRef(AutomationElement root, string targetRef, int maxElements, int maxDepth)
    {
        var wantedRuntimeId = ParseRuntimeId(targetRef);
        var queue = new Queue<(AutomationElement Element, int Depth)>();
        queue.Enqueue((root, 0));
        var visited = 0;

        while (queue.Count > 0 && visited < maxElements)
        {
            var (element, depth) = queue.Dequeue();
            visited += 1;
            try
            {
                if (RuntimeIdsEqual(element.GetRuntimeId(), wantedRuntimeId)) return element;
            }
            catch (ElementNotAvailableException)
            {
                continue;
            }

            if (depth >= maxDepth) continue;
            AutomationElement? child;
            try { child = TreeWalker.ControlViewWalker.GetFirstChild(element); }
            catch (ElementNotAvailableException) { continue; }
            while (child is not null && visited + queue.Count < maxElements * 2)
            {
                queue.Enqueue((child, depth + 1));
                try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
                catch (ElementNotAvailableException) { child = null; }
            }
        }

        return null;
    }

    private static int[] ParseRuntimeId(string targetRef)
    {
        if (!targetRef.StartsWith("uia:", StringComparison.Ordinal))
            throw new DriverFaultException("INVALID_ELEMENT_REF", "UIA element references must start with 'uia:'.", false);
        var parts = targetRef[4..].Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0 || parts.Any(part => !int.TryParse(part, out _)))
            throw new DriverFaultException("INVALID_ELEMENT_REF", $"Invalid UIA element reference: {targetRef}", false);
        return parts.Select(int.Parse).ToArray();
    }

    private static bool RuntimeIdsEqual(int[]? actual, int[] expected) =>
        actual is not null && actual.Length == expected.Length && actual.SequenceEqual(expected);

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

    private static WindowObservation? TryMapWindowFromHandle(long handle)
    {
        if (handle == 0 || !IsWindow(new IntPtr(handle))) return null;
        try { return TryMapWindow(AutomationElement.FromHandle(new IntPtr(handle))); }
        catch (ElementNotAvailableException) { return null; }
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
            string? value = null;
            var canInvoke = element.TryGetCurrentPattern(InvokePattern.Pattern, out _);
            var canSetValue = element.TryGetCurrentPattern(ValuePattern.Pattern, out var rawValuePattern)
                && rawValuePattern is ValuePattern valuePattern;
            if (canSetValue)
            {
                try { value = valuePattern!.Current.Value; }
                catch (InvalidOperationException) { value = null; }
            }
            return new ElementObservation(
                Ref: runtimeId is null ? null : $"uia:{string.Join('.', runtimeId)}",
                Depth: depth,
                Name: current.Name,
                AutomationId: current.AutomationId,
                ClassName: current.ClassName,
                ControlType: current.ControlType?.ProgrammaticName,
                Value: value,
                IsEnabled: current.IsEnabled,
                IsOffscreen: current.IsOffscreen,
                IsKeyboardFocusable: current.IsKeyboardFocusable,
                CanInvoke: canInvoke,
                CanSetValue: canSetValue,
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

    private static long ReadRequiredLong(JsonElement parameters, string name)
    {
        var value = ReadOptionalLong(parameters, name);
        return value ?? throw new DriverFaultException("INVALID_REQUEST", $"{name} is required.", false);
    }

    private static string ReadRequiredString(JsonElement parameters, string name, bool allowEmpty = false)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty(name, out var value) ||
            value.ValueKind != JsonValueKind.String)
            throw new DriverFaultException("INVALID_REQUEST", $"{name} is required.", false);
        var parsed = value.GetString() ?? string.Empty;
        if (!allowEmpty && string.IsNullOrWhiteSpace(parsed))
            throw new DriverFaultException("INVALID_REQUEST", $"{name} is required.", false);
        return parsed;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hWnd);
}

internal sealed class DriverFaultException(string code, string message, bool retryable) : Exception(message)
{
    public string Code { get; } = code;
    public bool Retryable { get; } = retryable;
}

internal sealed record DriverRequest(string? Id, string Method, JsonElement Params);
internal sealed record DriverResponse(string? Id, bool Ok, object? Result, DriverError? Error);
internal sealed record DriverError(string Code, string Message, bool Retryable);
internal sealed record WindowObservation(long Handle, string Name, string ClassName, int ProcessId, bool IsEnabled, bool IsOffscreen, RectObservation Bounds);
internal sealed record ElementObservation(string? Ref, int Depth, string Name, string AutomationId, string ClassName, string? ControlType, string? Value, bool IsEnabled, bool IsOffscreen, bool IsKeyboardFocusable, bool CanInvoke, bool CanSetValue, RectObservation Bounds);
internal sealed record RectObservation(double X, double Y, double Width, double Height)
{
    public static RectObservation From(System.Windows.Rect rect) => new(rect.X, rect.Y, rect.Width, rect.Height);
}
