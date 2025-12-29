import {PRIMARY_OUTLET} from '../src/shared';
import {DefaultUrlSerializer, UrlTree, UrlSegmentGroup, UrlSegment} from '../src/url_tree';

describe('Trailing Slash Support', () => {
  const serializer = new DefaultUrlSerializer();

  it('should parse trailing slash as hasTrailingSlash=true and NO empty segment', () => {
    const tree = serializer.parse('/a/b/');
    const primary = tree.root.children[PRIMARY_OUTLET];
    expect(primary.segments.map((s) => s.path)).toEqual(['a', 'b']);
    expect(tree.hasTrailingSlash).toBe(true);
  });

  it('should serialize hasTrailingSlash=true as trailing slash', () => {
    const tree = serializer.parse('/a/b/');
    const serialized = serializer.serialize(tree);
    expect(serialized).toEqual('/a/b/');
  });

  it('should parse trailing slash with query params', () => {
    const tree = serializer.parse('/a/b/?q=1');
    const primary = tree.root.children[PRIMARY_OUTLET];
    expect(primary.segments.map((s) => s.path)).toEqual(['a', 'b']);
    expect(tree.hasTrailingSlash).toBe(true);
    expect(tree.queryParams).toEqual({q: '1'});
  });

  it('should serialize hasTrailingSlash=true with query params', () => {
    const tree = serializer.parse('/a/b/?q=1');
    const serialized = serializer.serialize(tree);
    expect(serialized).toEqual('/a/b/?q=1');
  });

  it('should NOT start with hasTrailingSlash for /a/b', () => {
    const tree = serializer.parse('/a/b');
    expect(tree.hasTrailingSlash).toBe(false);
  });

  it('should parse trailing slash with fragment', () => {
    const tree = serializer.parse('/a/b/#frag');
    const primary = tree.root.children[PRIMARY_OUTLET];
    expect(primary.segments.map((s) => s.path)).toEqual(['a', 'b']);
    expect(tree.hasTrailingSlash).toBe(true);
    expect(tree.fragment).toEqual('frag');
  });

  it('should serialize hasTrailingSlash=true with fragment', () => {
    const tree = serializer.parse('/a/b/#frag');
    const serialized = serializer.serialize(tree);
    expect(serialized).toEqual('/a/b/#frag');
  });

  it('should NOT parse slash before secondary route as trailing slash', () => {
    const tree = serializer.parse('/a/b/(aux:c)');
    const primary = tree.root.children[PRIMARY_OUTLET];
    expect(primary.segments.map((s) => s.path)).toEqual(['a', 'b']);
    expect(tree.hasTrailingSlash).toBe(false);
    expect(primary.children['aux'].segments[0].path).toEqual('c');
  });

  it('should stop parsing at double slash and NOT set trailing slash', () => {
    const tree = serializer.parse('/a/b//c');
    const primary = tree.root.children[PRIMARY_OUTLET];
    expect(primary.segments.map((s) => s.path)).toEqual(['a', 'b']);
    expect(tree.hasTrailingSlash).toBe(false);
  });

  it('should normalize double slash at start to single slash', () => {
    const tree = serializer.parse('//a');
    const primary = tree.root.children[PRIMARY_OUTLET];
    expect(primary.segments.map((s) => s.path)).toEqual(['a']);
    expect(tree.hasTrailingSlash).toBe(false);
  });
});
