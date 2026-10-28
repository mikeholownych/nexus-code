import type { CanonicalCapability } from "../capabilities.js";

export const browserNavigateCapability: CanonicalCapability = {
  "id": "browser_nav",
  "modelToolName": "browser_navigate",
  "category": "browser",
  "mutating": false,
  "effect": "egress",
  "sideEffectContract": "Navigate simulated browser to URL",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "browser_navigate",
      "description": "Navigate the headless browser to a local development server URL (e.g. http://localhost:3000), web page, or HTML file for runtime verification.",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "The complete HTTP/HTTPS URL or local HTML file path to load."
          }
        },
        "required": [
          "url"
        ]
      }
    }
  }
};

export const browserScreenshotCapability: CanonicalCapability = {
  "id": "browser_shot",
  "modelToolName": "browser_screenshot",
  "category": "browser",
  "mutating": false,
  "effect": "egress",
  "sideEffectContract": "Capture simulated browser viewport screenshot",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "browser_screenshot",
      "description": "Capture a viewport screenshot of the active browser page to verify frontend layout or UI state.",
      "parameters": {
        "type": "object",
        "properties": {
          "output_path": {
            "type": "string",
            "description": "Optional destination file path for screenshot PNG (defaults to .nexus/screenshots/)."
          }
        }
      }
    }
  }
};

export const browserClickCapability: CanonicalCapability = {
  "id": "browser_interact",
  "modelToolName": "browser_click",
  "category": "browser",
  "mutating": false,
  "effect": "egress",
  "sideEffectContract": "Simulate mouse click on DOM selector element",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "browser_click",
      "description": "Click an interactive DOM element on the active browser page by CSS selector or element ID.",
      "parameters": {
        "type": "object",
        "properties": {
          "selector": {
            "type": "string",
            "description": "CSS selector of the element to click (e.g. '#submit-btn' or 'button.login')."
          }
        },
        "required": [
          "selector"
        ]
      }
    }
  }
};

export const browserTypeCapability: CanonicalCapability = {
  "id": "browser_interact",
  "modelToolName": "browser_type",
  "category": "browser",
  "mutating": true,
  "effect": "egress",
  "changesWorkspace": false,
  "sideEffectContract": "Simulate keyboard text typing into DOM selector element",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "browser_type",
      "description": "Type text into an input field or textarea on the active browser page.",
      "parameters": {
        "type": "object",
        "properties": {
          "selector": {
            "type": "string",
            "description": "CSS selector of target input element."
          },
          "text": {
            "type": "string",
            "description": "Text to enter into the target field."
          }
        },
        "required": [
          "selector",
          "text"
        ]
      }
    }
  }
};

export const browserConsoleLogsCapability: CanonicalCapability = {
  "id": "browser_logs",
  "modelToolName": "browser_console_logs",
  "category": "browser",
  "mutating": false,
  "effect": "egress",
  "sideEffectContract": "Retrieve captured simulated browser console log messages",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "browser_console_logs",
      "description": "Inspect browser console logs, warnings, and uncaught exceptions for frontend diagnostics.",
      "parameters": {
        "type": "object",
        "properties": {
          "limit": {
            "type": "number",
            "description": "Maximum recent log entries to return (default: 50)."
          }
        }
      }
    }
  }
};
