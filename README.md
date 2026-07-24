# DCS-MCP

DCS-MCP is a Model Context Protocol (MCP) server that provides a secure, standardized interface between AI assistants and DCS services. It enables MCP-compatible clients to discover tools, access approved enterprise data, and execute supported workflows.

> **Status:** Early development. Features, configuration, and interfaces may change.

## Features

- MCP-compatible server implementation
- Secure integration with DCS services and APIs
- Tool discovery and execution
- Configurable authentication and authorization
- Structured logging, health checks, and error handling
- Extensible architecture for adding new tools and resources

## Architecture

```text
+------------------------+
| MCP-compatible client  |
| Copilot / AI agent     |
+-----------+------------+
            |
            | Model Context Protocol
            v
+-----------+------------+
|        DCS-MCP         |
| Tools | Resources      |
| Auth  | Validation     |
+-----------+------------+
            |
            | Approved APIs
            v
+-----------+------------+
|      DCS services      |
| Data | APIs | Workflows|
+------------------------+
```

## Prerequisites

- Node.js 18 or later
- npm
- Access to the required DCS services
- Credentials or an API token for the target environment
- An MCP-compatible client

## Getting Started

### Clone the repository

```bash
git clone https://github.com/<organisation>/dcs-mcp.git
cd dcs-mcp
```

### Install dependencies

```bash
npm install
```

## License

You may use, reproduce, modify, and distribute this project in accordance with the terms and conditions of the Apache License 2.0.
