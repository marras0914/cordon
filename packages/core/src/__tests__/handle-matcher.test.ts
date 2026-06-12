import { describe, it, expect } from 'vitest';
import { extractHandles, findSharedHandles } from '../policies/handle-matcher.js';

describe('handle-matcher', () => {
  describe('extractHandles', () => {
    it('extracts a UUID', () => {
      const h = extractHandles({ id: '550e8400-e29b-41d4-a716-446655440000' });
      expect(h.has('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('extracts a long hex token (hash / record id)', () => {
      const h = extractHandles({ sha: 'a1b2c3d4e5f60718' });
      expect(h.has('a1b2c3d4e5f60718')).toBe(true);
    });

    it('extracts a unix temp path', () => {
      const h = extractHandles({ path: '/tmp/export-3.csv' });
      expect([...h]).toContain('/tmp/export-3.csv');
    });

    it('extracts a windows path', () => {
      const h = extractHandles('wrote C:\\Users\\me\\data.db');
      expect([...h].some((x) => x.startsWith('C:\\Users\\me'))).toBe(true);
    });

    it('extracts a base64url cursor token', () => {
      const token = 'eyJvZmZzZXQiOjEwMCwibGltaXQiOjUw';
      const h = extractHandles({ cursor: token });
      expect(h.has(token)).toBe(true);
    });

    it('does not extract short / common words', () => {
      const h = extractHandles({ status: 'ok', count: 5, name: 'users' });
      expect(h.size).toBe(0);
    });

    it('handles null / undefined / primitives without throwing', () => {
      expect(extractHandles(null).size).toBe(0);
      expect(extractHandles(undefined).size).toBe(0);
      expect(extractHandles(42).size).toBe(0);
    });

    it('scans nested response shapes (MCP content blocks)', () => {
      const response = {
        content: [{ type: 'text', text: 'created record 7f3e9a1b2c4d5e6f' }],
        isError: false,
      };
      expect(extractHandles(response).has('7f3e9a1b2c4d5e6f')).toBe(true);
    });
  });

  describe('findSharedHandles', () => {
    it('detects a UUID flowing from response into next args', () => {
      const prev = extractHandles({ recordId: '550e8400-e29b-41d4-a716-446655440000' });
      const shared = findSharedHandles(prev, { id: '550e8400-e29b-41d4-a716-446655440000', op: 'update' });
      expect(shared).toEqual(['550e8400-e29b-41d4-a716-446655440000']);
    });

    it('detects a temp path flowing from a read into a write', () => {
      const prev = extractHandles({ content: [{ type: 'text', text: 'saved to /tmp/export-0.csv' }] });
      const shared = findSharedHandles(prev, { path: '/tmp/export-0.csv', content: 'rows' });
      expect(shared).toContain('/tmp/export-0.csv');
    });

    it('returns empty when no handle crosses the boundary', () => {
      const prev = extractHandles({ id: '550e8400-e29b-41d4-a716-446655440000' });
      // Different unrelated id in the next call — coincidental ordering, no link.
      const shared = findSharedHandles(prev, { id: '11111111-2222-3333-4444-555555555555' });
      expect(shared).toEqual([]);
    });

    it('returns empty when there are no previous handles', () => {
      expect(findSharedHandles(new Set(), { id: '550e8400-e29b-41d4-a716-446655440000' })).toEqual([]);
    });
  });
});
