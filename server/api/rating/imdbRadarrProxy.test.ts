import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import IMDBRadarrProxy from '@server/api/rating/imdbRadarrProxy';
import cacheManager from '@server/lib/cache';

function getAxios(proxy: IMDBRadarrProxy): AxiosInstance {
  return (proxy as unknown as { axios: AxiosInstance }).axios;
}

const movie = (tmdbId: number, value: number, count = 1000) => ({
  TmdbId: tmdbId,
  MovieRatings: { Imdb: { Value: value, Count: count, Type: 'User' } },
});

describe('IMDBRadarrProxy getBulkRatingsByTmdbId', () => {
  beforeEach(() => cacheManager.getCache('imdb').flush());
  afterEach(() => mock.restoreAll());

  it('maps IMDb ratings by TMDB id and nulls missing ones', async () => {
    const proxy = new IMDBRadarrProxy();
    const post = mock.method(getAxios(proxy), 'post', async () => ({
      data: [
        movie(550, 8.8),
        movie(603, 8.7, 0),
        { TmdbId: 604, MovieRatings: {} },
      ],
    }));

    const ratings = await proxy.getBulkRatingsByTmdbId([550, 603, 604, 605]);

    assert.strictEqual(post.mock.callCount(), 1);
    assert.strictEqual(post.mock.calls[0].arguments[0], '/movie/bulk');
    assert.deepStrictEqual(
      post.mock.calls[0].arguments[1],
      [550, 603, 604, 605]
    );
    assert.strictEqual(ratings.get(550), 8.8);
    assert.strictEqual(ratings.get(603), null);
    assert.strictEqual(ratings.get(604), null);
    assert.strictEqual(ratings.get(605), null);
  });

  it('only requests movies missing from the cache', async () => {
    const proxy = new IMDBRadarrProxy();
    const post = mock.method(getAxios(proxy), 'post', async () => ({
      data: [movie(550, 8.8), movie(603, 8.7)],
    }));

    await proxy.getBulkRatingsByTmdbId([550]);
    const ratings = await proxy.getBulkRatingsByTmdbId([550, 603]);

    assert.strictEqual(post.mock.callCount(), 2);
    assert.deepStrictEqual(post.mock.calls[1].arguments[1], [603]);
    assert.strictEqual(ratings.get(550), 8.8);
    assert.strictEqual(ratings.get(603), 8.7);
  });

  it('does not cache failed requests', async () => {
    const proxy = new IMDBRadarrProxy();
    let fail = true;
    mock.method(getAxios(proxy), 'post', async () => {
      if (fail) {
        throw new Error('boom');
      }
      return { data: [movie(550, 8.8)] };
    });

    const ratings = await proxy.getBulkRatingsByTmdbId([550]);
    assert.strictEqual(ratings.get(550), null);

    fail = false;
    const retried = await proxy.getBulkRatingsByTmdbId([550]);
    assert.strictEqual(retried.get(550), 8.8);
  });
});
