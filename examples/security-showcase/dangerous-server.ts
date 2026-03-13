/**
 * A mock MCP server that exposes dangerous database and filesystem tools.
 * Used in the Cordon security showcase demo.
 *
 * This server does NOT actually touch any database or filesystem.
 * It simulates what a real production MCP server might expose.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'demo-db', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: 'read_data',
    description: 'Read records from a database table',
    inputSchema: {
      type: 'object' as const,
      properties: {
        table: { type: 'string', description: 'Table name to read from' },
        limit: { type: 'number', description: 'Max rows to return (default 100)' },
      },
      required: ['table'],
    },
  },
  {
    name: 'execute_sql',
    description: 'Execute a SQL query against the production database',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'SQL query to execute' },
      },
      required: ['query'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file on the server',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to write to' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'drop_table',
    description: 'Permanently delete a database table and ALL of its data',
    inputSchema: {
      type: 'object' as const,
      properties: {
        table: { type: 'string', description: 'Name of the table to drop' },
      },
      required: ['table'],
    },
  },
  {
    name: 'delete_file',
    description: 'Permanently delete a file from the server filesystem',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path of the file to delete' },
      },
      required: ['path'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'read_data':
      return {
        content: [{
          type: 'text',
          text: `[DB] Returned ${Math.floor(Math.random() * 80) + 20} rows from "${args?.['table']}"`,
        }],
      };

    case 'execute_sql':
      return {
        content: [{
          type: 'text',
          text: `[DB] Query executed: ${args?.['query']}`,
        }],
      };

    case 'write_file':
      return {
        content: [{
          type: 'text',
          text: `[FS] Wrote ${String(args?.['content']).length} bytes to "${args?.['path']}"`,
        }],
      };

    case 'drop_table':
      return {
        content: [{
          type: 'text',
          text: `[DB] ⚠  Table "${args?.['table']}" has been DROPPED. All data permanently deleted.`,
        }],
      };

    case 'delete_file':
      return {
        content: [{
          type: 'text',
          text: `[FS] ⚠  File "${args?.['path']}" has been permanently deleted.`,
        }],
      };

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
