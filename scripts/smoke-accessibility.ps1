param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace TarveAccessibilitySmoke {
  [Flags]
  public enum TreeScope {
    Element = 1,
    Children = 2,
    Descendants = 4,
    Subtree = 7,
  }

  [ComImport]
  [Guid("352ffba8-0973-437c-a61f-f64cafd81df9")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IUIAutomationCondition {}

  [ComImport]
  [Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IUIAutomationElement {
    [PreserveSig] int SetFocus();
    [PreserveSig] int GetRuntimeId(out IntPtr runtimeId);
    [PreserveSig] int FindFirst(TreeScope scope, IUIAutomationCondition condition, out IUIAutomationElement found);
    [PreserveSig] int FindAll(TreeScope scope, IUIAutomationCondition condition, out IntPtr found);
    [PreserveSig] int FindFirstBuildCache(TreeScope scope, IUIAutomationCondition condition, IntPtr cacheRequest, out IUIAutomationElement found);
    [PreserveSig] int FindAllBuildCache(TreeScope scope, IUIAutomationCondition condition, IntPtr cacheRequest, out IntPtr found);
    [PreserveSig] int BuildUpdatedCache(IntPtr cacheRequest, out IUIAutomationElement updatedElement);
    [PreserveSig] int GetCurrentPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object value);
  }

  [ComImport]
  [Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IUIAutomation {
    [PreserveSig] int CompareElements(IntPtr el1, IntPtr el2, out int areSame);
    [PreserveSig] int CompareRuntimeIds(IntPtr runtimeId1, IntPtr runtimeId2, out int areSame);
    [PreserveSig] int GetRootElement(out IUIAutomationElement root);
    [PreserveSig] int ElementFromHandle(IntPtr hwnd, out IUIAutomationElement element);
    [PreserveSig] int ElementFromPoint(long point, out IUIAutomationElement element);
    [PreserveSig] int GetFocusedElement(out IUIAutomationElement element);
    [PreserveSig] int GetRootElementBuildCache(IntPtr cacheRequest, out IUIAutomationElement root);
    [PreserveSig] int ElementFromHandleBuildCache(IntPtr hwnd, IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int ElementFromPointBuildCache(long point, IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int GetFocusedElementBuildCache(IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int CreateTreeWalker(IUIAutomationCondition condition, out IntPtr walker);
    [PreserveSig] int GetControlViewWalker(out IntPtr walker);
    [PreserveSig] int GetContentViewWalker(out IntPtr walker);
    [PreserveSig] int GetRawViewWalker(out IntPtr walker);
    [PreserveSig] int GetRawViewCondition(out IUIAutomationCondition condition);
    [PreserveSig] int GetControlViewCondition(out IUIAutomationCondition condition);
    [PreserveSig] int GetContentViewCondition(out IUIAutomationCondition condition);
    [PreserveSig] int CreateCacheRequest(out IntPtr cacheRequest);
    [PreserveSig] int CreateTrueCondition(out IUIAutomationCondition condition);
    [PreserveSig] int CreateFalseCondition(out IUIAutomationCondition condition);
    [PreserveSig] int CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value, out IUIAutomationCondition condition);
    [PreserveSig] int CreatePropertyConditionEx(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value, int flags, out IUIAutomationCondition condition);
    [PreserveSig] int CreateAndCondition(IUIAutomationCondition condition1, IUIAutomationCondition condition2, out IUIAutomationCondition condition);
  }

  public static class NativeUia {
    const int UIA_NamePropertyId = 30005;
    const int UIA_ControlTypePropertyId = 30003;

    static void Check(int hr) {
      if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }

    public static object GetCurrentPropertyValue(IntPtr hwnd, string name, int controlTypeId, int propertyId) {
      var type = Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"), true);
      var automation = (IUIAutomation)Activator.CreateInstance(type);
      IUIAutomationElement root = null;
      IUIAutomationElement element = null;
      IUIAutomationCondition nameCondition = null;
      IUIAutomationCondition typeCondition = null;
      IUIAutomationCondition condition = null;
      try {
        Check(automation.ElementFromHandle(hwnd, out root));
        Check(automation.CreatePropertyCondition(UIA_NamePropertyId, name, out nameCondition));
        Check(automation.CreatePropertyCondition(UIA_ControlTypePropertyId, controlTypeId, out typeCondition));
        Check(automation.CreateAndCondition(nameCondition, typeCondition, out condition));
        Check(root.FindFirst(TreeScope.Descendants, condition, out element));
        if (element == null) throw new InvalidOperationException("UIA element not found: " + name);
        object value;
        Check(element.GetCurrentPropertyValue(propertyId, out value));
        return value;
      } finally {
        if (element != null) Marshal.ReleaseComObject(element);
        if (condition != null) Marshal.ReleaseComObject(condition);
        if (typeCondition != null) Marshal.ReleaseComObject(typeCondition);
        if (nameCondition != null) Marshal.ReleaseComObject(nameCondition);
        if (root != null) Marshal.ReleaseComObject(root);
        if (automation != null) Marshal.ReleaseComObject(automation);
      }
    }
  }
}
'@

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "Accessibility smoke failed: $Message" }
}

function Wait-Until {
  param([scriptblock]$Probe, [string]$Message, [int]$TimeoutMs = 8000)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $result = & $Probe
    if ($null -ne $result) { return $result }
    Start-Sleep -Milliseconds 80
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Accessibility smoke timed out: $Message"
}

function Find-ByName {
  param(
    [System.Windows.Automation.AutomationElement]$RootElement,
    [string]$Name
  )
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $Name
  )
  return $RootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Wait-ByName {
  param(
    [System.Windows.Automation.AutomationElement]$RootElement,
    [string]$Name,
    [int]$TimeoutMs = 8000
  )
  return Wait-Until -TimeoutMs $TimeoutMs -Message "element '$Name'" -Probe {
    Find-ByName -RootElement $RootElement -Name $Name
  }
}

function Find-ByNameAndType {
  param(
    [System.Windows.Automation.AutomationElement]$RootElement,
    [string]$Name,
    [System.Windows.Automation.ControlType]$ControlType
  )
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $Name
  )
  $matches = $RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  foreach ($match in $matches) {
    if ($match.Current.ControlType -eq $ControlType) { return $match }
  }
  return $null
}

function Wait-ByNameAndType {
  param(
    [System.Windows.Automation.AutomationElement]$RootElement,
    [string]$Name,
    [System.Windows.Automation.ControlType]$ControlType,
    [int]$TimeoutMs = 8000
  )
  return Wait-Until -TimeoutMs $TimeoutMs -Message "element '$Name' with type $($ControlType.ProgrammaticName)" -Probe {
    Find-ByNameAndType -RootElement $RootElement -Name $Name -ControlType $ControlType
  }
}

function Get-Pattern {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [System.Windows.Automation.AutomationPattern]$Pattern,
    [string]$Label
  )
  $instance = $null
  if (-not $Element.TryGetCurrentPattern($Pattern, [ref]$instance)) {
    throw "Accessibility smoke failed: '$Label' does not expose $($Pattern.ProgrammaticName)"
  }
  return $instance
}

function Get-ControlViewNames {
  param([System.Windows.Automation.AutomationElement]$RootElement)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $names = New-Object System.Collections.Generic.List[string]
  $stack = New-Object System.Collections.Generic.Stack[System.Windows.Automation.AutomationElement]
  $stack.Push($RootElement)
  while ($stack.Count -gt 0) {
    $parent = $stack.Pop()
    $child = $walker.GetFirstChild($parent)
    while ($null -ne $child) {
      $name = $child.Current.Name
      if (-not [string]::IsNullOrEmpty($name)) { $names.Add($name) }
      $stack.Push($child)
      $child = $walker.GetNextSibling($child)
    }
  }
  return @($names)
}

function Assert-NoSecret {
  param(
    [System.Windows.Automation.AutomationElement]$RootElement,
    [string]$Secret
  )
  $elements = $RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($element in $elements) {
    foreach ($candidate in @($element.Current.Name, $element.Current.HelpText, $element.Current.ItemStatus)) {
      Assert-True (-not ($candidate -and $candidate.Contains($Secret))) "password plaintext leaked through a UIA property"
    }
    $value = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)) {
      $currentValue = ([System.Windows.Automation.ValuePattern]$value).Current.Value
      Assert-True (-not ($currentValue -and $currentValue.Contains($Secret))) "password plaintext leaked through ValuePattern"
    }
    $text = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$text)) {
      $documentText = ([System.Windows.Automation.TextPattern]$text).DocumentRange.GetText(-1)
      Assert-True (-not ($documentText -and $documentText.Contains($Secret))) "password plaintext leaked through TextPattern"
    }
  }
}

$bunCommand = Get-Command bun.exe -ErrorAction SilentlyContinue
if (-not $bunCommand) { $bunCommand = Get-Command bun -ErrorAction Stop }
$bun = $bunCommand.Source
$entry = Join-Path $Root "scripts\accessibility-smoke-app.tsx"
$nativeDll = Join-Path $Root "native\target\debug\tarve_native.dll"
Assert-True (Test-Path -LiteralPath $nativeDll -PathType Leaf) "debug native DLL not found at '$nativeDll'; run 'bun run build:native' first"
$previousNative = $env:TARVE_NATIVE
$process = $null

try {
  $env:TARVE_NATIVE = $nativeDll
  $process = Start-Process -FilePath $bun -ArgumentList @($entry) -WorkingDirectory $Root -WindowStyle Hidden -PassThru

  $desktop = [System.Windows.Automation.AutomationElement]::RootElement
  $window = Wait-Until -Message "Tarve accessibility window" -Probe {
    $candidate = Find-ByName -RootElement $desktop -Name "Tarve Accessibility Smoke"
    if ($candidate -and $candidate.Current.ProcessId -eq $process.Id) { $candidate } else { $null }
  }
  Assert-True ($window.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) "root must publish ControlType.Window"

  $email = Wait-ByNameAndType -RootElement $window -Name "Email address" -ControlType ([System.Windows.Automation.ControlType]::Edit)
  Assert-True ([bool]$email.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsRequiredForFormProperty)) "Field.required must reach UIA"
  $isDataValidValue = [TarveAccessibilitySmoke.NativeUia]::GetCurrentPropertyValue(
    [IntPtr]$window.Current.NativeWindowHandle,
    "Email address",
    $email.Current.ControlType.Id,
    30103
  )
  Assert-True (-not [bool]$isDataValidValue) "Field.error must publish UIA_IsDataValidForForm=false"
  $emailDescription = [TarveAccessibilitySmoke.NativeUia]::GetCurrentPropertyValue(
    [IntPtr]$window.Current.NativeWindowHandle,
    "Email address",
    $email.Current.ControlType.Id,
    30159
  )
  Assert-True ($emailDescription -eq "Email validation message") "Field.error must reach UIA FullDescription"

  $emailValue = [System.Windows.Automation.ValuePattern](Get-Pattern -Element $email -Pattern ([System.Windows.Automation.ValuePattern]::Pattern) -Label "Email address")
  $null = Get-Pattern -Element $email -Pattern ([System.Windows.Automation.TextPattern]::Pattern) -Label "Email address"
  $email.SetFocus()
  $focused = Wait-Until -Message "UIA focus on Email address" -Probe {
    $current = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($current -and $current.Current.Name -eq "Email address") { $current } else { $null }
  }
  Assert-True ($focused.Current.ProcessId -eq $process.Id) "focus notification must remain in the Tarve process"

  $emailValue.SetValue("uia@example.com")
  $null = Wait-Until -Message "controlled ValuePattern reconciliation" -Probe {
    $candidate = Find-ByNameAndType -RootElement $window -Name "Email address" -ControlType ([System.Windows.Automation.ControlType]::Edit)
    if (-not $candidate) { return $null }
    $pattern = $null
    if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      if (([System.Windows.Automation.ValuePattern]$pattern).Current.Value -eq "uia@example.com") { return $candidate }
    }
    return $null
  }

  $notes = Wait-ByNameAndType -RootElement $window -Name "Notes" -ControlType ([System.Windows.Automation.ControlType]::Edit)
  $notesText = [System.Windows.Automation.TextPattern](Get-Pattern -Element $notes -Pattern ([System.Windows.Automation.TextPattern]::Pattern) -Label "Notes")
  $documentText = $notesText.DocumentRange.GetText(-1)
  Assert-True ($documentText.Contains("First line")) "TextPattern must expose multiline text"
  $hebrew = -join @([char]0x05D0, [char]0x05D1, [char]0x05D2)
  Assert-True ($documentText.Contains($hebrew)) "TextPattern must preserve bidirectional text"
  $notesDescription = [TarveAccessibilitySmoke.NativeUia]::GetCurrentPropertyValue(
    [IntPtr]$window.Current.NativeWindowHandle,
    "Notes",
    $notes.Current.ControlType.Id,
    30159
  )
  Assert-True ($notesDescription -eq "Multiline bidirectional text.") "Field description must reach UIA FullDescription"

  $passwordElement = Wait-ByNameAndType -RootElement $window -Name "Password" -ControlType ([System.Windows.Automation.ControlType]::Edit)
  Assert-True ([bool]$passwordElement.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsPasswordProperty)) "password edit must publish IsPassword"
  Assert-NoSecret -RootElement $window -Secret "topsecret"

  $navigation = Wait-ByNameAndType -RootElement $window -Name "Overview nav" -ControlType ([System.Windows.Automation.ControlType]::CheckBox)
  $navigationToggle = [System.Windows.Automation.TogglePattern](Get-Pattern -Element $navigation -Pattern ([System.Windows.Automation.TogglePattern]::Pattern) -Label "Overview nav")
  Assert-True ($navigationToggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) "selected NavigationMenu item must publish TogglePattern=On"

  $select = Wait-ByNameAndType -RootElement $window -Name "Alpha option" -ControlType ([System.Windows.Automation.ControlType]::ComboBox)
  $selectOption = Wait-ByNameAndType -RootElement $window -Name "Beta option" -ControlType ([System.Windows.Automation.ControlType]::ListItem)
  $selectSelection = [System.Windows.Automation.SelectionItemPattern](Get-Pattern -Element $selectOption -Pattern ([System.Windows.Automation.SelectionItemPattern]::Pattern) -Label "Beta option")
  Assert-True ($null -ne $selectSelection.Current.SelectionContainer) "Select option must publish a SelectionContainer"
  Assert-True ($selectSelection.Current.SelectionContainer.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox) "Select option SelectionContainer must be the ComboBox"
  Assert-True (-not $selectSelection.Current.IsSelected) "unselected Select option must publish IsSelected=false"

  $grid = Wait-ByNameAndType -RootElement $window -Name "Data grid" -ControlType ([System.Windows.Automation.ControlType]::DataGrid)
  $gridRow = Wait-ByNameAndType -RootElement $window -Name "Row 1" -ControlType ([System.Windows.Automation.ControlType]::ListItem)
  $gridSelectionItem = [System.Windows.Automation.SelectionItemPattern](Get-Pattern -Element $gridRow -Pattern ([System.Windows.Automation.SelectionItemPattern]::Pattern) -Label "Row 1")
  Assert-True ($gridSelectionItem.Current.IsSelected) "selected DataGrid row must publish IsSelected=true"
  Assert-True ($null -ne $gridSelectionItem.Current.SelectionContainer) "DataGrid row must publish a SelectionContainer"
  Assert-True ($gridSelectionItem.Current.SelectionContainer.Current.ControlType -eq [System.Windows.Automation.ControlType]::DataGrid) "DataGrid row SelectionContainer must be the DataGrid"

  $scrollTarget = Wait-ByName -RootElement $window -Name "Bring me into view"
  $scrollItem = [System.Windows.Automation.ScrollItemPattern](Get-Pattern -Element $scrollTarget -Pattern ([System.Windows.Automation.ScrollItemPattern]::Pattern) -Label "Bring me into view")
  $scrollItem.ScrollIntoView()
  $null = Wait-Until -Message "ScrollIntoView target visibility" -Probe {
    $candidate = Find-ByName -RootElement $window -Name "Bring me into view"
    if ($candidate -and -not $candidate.Current.IsOffscreen) { $candidate } else { $null }
  }

  $openDialog = Wait-ByNameAndType -RootElement $window -Name "Open accessibility dialog" -ControlType ([System.Windows.Automation.ControlType]::Button)
  $invoke = [System.Windows.Automation.InvokePattern](Get-Pattern -Element $openDialog -Pattern ([System.Windows.Automation.InvokePattern]::Pattern) -Label "Open accessibility dialog")
  $invoke.Invoke()

  $dialog = Wait-ByNameAndType -RootElement $window -Name "Accessibility dialog" -ControlType ([System.Windows.Automation.ControlType]::Window)
  $controlNames = Get-ControlViewNames -RootElement $window
  Assert-True (-not ($controlNames -contains "Open accessibility dialog")) "background controls must leave UIA Control View while modal is active"
  Assert-True ($controlNames -contains "Dialog value") "modal edit must remain in UIA Control View"

  $dialogInput = Wait-ByNameAndType -RootElement $dialog -Name "Dialog value" -ControlType ([System.Windows.Automation.ControlType]::Edit)
  $null = Get-Pattern -Element $dialogInput -Pattern ([System.Windows.Automation.ValuePattern]::Pattern) -Label "Dialog value"
  $dialogText = [System.Windows.Automation.TextPattern](Get-Pattern -Element $dialogInput -Pattern ([System.Windows.Automation.TextPattern]::Pattern) -Label "Dialog value")
  $modalFocus = [System.Windows.Automation.AutomationElement]::FocusedElement
  Assert-True ($modalFocus.Current.ProcessId -eq $process.Id) "opening modal must move UIA focus into the app"
  Assert-True ($modalFocus.Current.Name -eq "Dialog value") "modal fallback focus must initialize the first editable control"
  $dialogSelection = $dialogText.GetSelection()
  Assert-True ($dialogSelection.Length -eq 1) "modal edit must publish a single TextPattern selection"
  $dialogSelectedText = $dialogSelection[0].GetText(-1)
  Assert-True ($dialogSelectedText -eq "") "modal fallback focus must initialize a collapsed caret"

  $close = Wait-ByNameAndType -RootElement $dialog -Name "Close dialog" -ControlType ([System.Windows.Automation.ControlType]::Button)
  $closeInvoke = [System.Windows.Automation.InvokePattern](Get-Pattern -Element $close -Pattern ([System.Windows.Automation.InvokePattern]::Pattern) -Label "Close dialog")
  $closeInvoke.Invoke()
  $null = Wait-Until -Message "dialog close and focus restoration" -Probe {
    $dialogAfter = Find-ByName -RootElement $window -Name "Accessibility dialog"
    $focusAfter = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $dialogAfter -and $focusAfter -and $focusAfter.Current.Name -eq "Open accessibility dialog") { $focusAfter } else { $null }
  }

  Assert-NoSecret -RootElement $window -Secret "topsecret"

  [ordered]@{
    result = "PASS"
    window = $window.Current.Name
    emailControl = $email.Current.ControlType.ProgrammaticName
    valuePattern = $true
    textPattern = $true
    fieldRequired = $true
    fieldInvalid = $true
    fieldFullDescription = $true
    bidiText = $true
    passwordSecret = "not exposed"
    navigationToggle = $true
    selectSelectionContainer = $true
    dataGridSelection = $true
    modalIsolation = $true
    modalFocusRestore = $true
    scrollIntoView = "exercised"
  } | ConvertTo-Json
}
finally {
  if ($null -ne $process) {
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    $process.Dispose()
  }
  if ($null -eq $previousNative) {
    Remove-Item Env:TARVE_NATIVE -ErrorAction SilentlyContinue
  } else {
    $env:TARVE_NATIVE = $previousNative
  }
}
