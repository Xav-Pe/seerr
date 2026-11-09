import ExternalAPI from '@server/api/externalapi';
import type { CacheStore } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';

type IMDBRadarrProxyResponse = IMDBMovie[];

interface IMDBMovie {
  ImdbId: string;
  Overview: string;
  Title: string;
  OriginalTitle: string;
  TitleSlug: string;
  Ratings: Rating[];
  MovieRatings: MovieRatings;
  Runtime: number;
  Images: Image[];
  Genres: string[];
  Popularity: number;
  Premier: string;
  InCinema: string;
  PhysicalRelease: any;
  DigitalRelease: string;
  Year: number;
  AlternativeTitles: AlternativeTitle[];
  Translations: Translation[];
  Recommendations: Recommendation[];
  Credits: Credits;
  Studio: string;
  YoutubeTrailerId: string;
  Certifications: Certification[];
  Status: any;
  Collection: Collection;
  OriginalLanguage: string;
  Homepage: string;
  TmdbId: number;
}

interface Rating {
  Count: number;
  Value: number;
  Origin: string;
  Type: string;
}

interface MovieRatings {
  Tmdb: Tmdb;
  Imdb: Imdb;
  Metacritic: Metacritic;
  RottenTomatoes: RottenTomatoes;
}

interface Tmdb {
  Count: number;
  Value: number;
  Type: string;
}

interface Imdb {
  Count: number;
  Value: number;
  Type: string;
}

interface Metacritic {
  Count: number;
  Value: number;
  Type: string;
}

interface RottenTomatoes {
  Count: number;
  Value: number;
  Type: string;
}

interface Image {
  CoverType: string;
  Url: string;
}

interface AlternativeTitle {
  Title: string;
  Type: string;
  Language: string;
}

interface Translation {
  Title: string;
  Overview: string;
  Language: string;
}

interface Recommendation {
  TmdbId: number;
  Title: string;
}

interface Credits {
  Cast: Cast[];
  Crew: Crew[];
}

interface Cast {
  Name: string;
  Order: number;
  Character: string;
  TmdbId: number;
  CreditId: string;
  Images: Image2[];
}

interface Image2 {
  CoverType: string;
  Url: string;
}

interface Crew {
  Name: string;
  Job: string;
  Department: string;
  TmdbId: number;
  CreditId: string;
  Images: Image3[];
}

interface Image3 {
  CoverType: string;
  Url: string;
}

interface Certification {
  Country: string;
  Certification: string;
}

interface Collection {
  Name: string;
  Images: any;
  Overview: any;
  Translations: any;
  Parts: any;
  TmdbId: number;
}

const BULK_RATING_CACHE_TTL = 43200;
const BULK_RATING_CHUNK_SIZE = 100;

export interface IMDBRating {
  title: string;
  url: string;
  criticsScore: number;
  criticsScoreCount: number;
}

/**
 * This is a best-effort API. The IMDB API is technically
 * private and getting access costs money/requires approval.
 *
 * Radarr hosts a public proxy that's in use by all Radarr instances.
 */
class IMDBRadarrProxy extends ExternalAPI {
  private ratingCache: CacheStore = cacheManager.getCache('imdb').data;

  constructor() {
    super(
      'https://api.radarr.video/v1',
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        nodeCache: cacheManager.getCache('imdb').data,
      }
    );
  }

  /**
   * Ask the Radarr IMDB Proxy for the movie
   *
   * @param IMDBid Id of IMDB movie
   */
  public async getMovieRatings(IMDBid: string): Promise<IMDBRating | null> {
    try {
      const data = await this.get<IMDBRadarrProxyResponse>(
        `/movie/imdb/${IMDBid}`
      );

      if (
        !data?.length ||
        data[0].ImdbId !== IMDBid ||
        !data[0].MovieRatings.Imdb
      ) {
        return null;
      }

      return {
        title: data[0].Title,
        url: `https://www.imdb.com/title/${data[0].ImdbId}`,
        criticsScore: data[0].MovieRatings.Imdb.Value,
        criticsScoreCount: data[0].MovieRatings.Imdb.Count,
      };
    } catch (e) {
      throw new Error(
        `[IMDB RADARR PROXY API] Failed to retrieve movie ratings: ${e.message}`,
        { cause: e }
      );
    }
  }

  /**
   * Retrieve the IMDb user rating of several movies at once, by TMDB id.
   *
   * Ratings are cached per movie, so only unknown movies hit the proxy.
   * Movies without an IMDb rating (or that could not be retrieved) are
   * mapped to null.
   */
  public async getBulkRatingsByTmdbId(
    tmdbIds: number[]
  ): Promise<Map<number, number | null>> {
    const ratings = new Map<number, number | null>();
    const missing: number[] = [];

    for (const tmdbId of new Set(tmdbIds)) {
      const cached = this.ratingCache.get<number | null>(
        this.bulkRatingCacheKey(tmdbId)
      );
      if (cached !== undefined) {
        ratings.set(tmdbId, cached);
      } else {
        missing.push(tmdbId);
      }
    }

    for (let i = 0; i < missing.length; i += BULK_RATING_CHUNK_SIZE) {
      const chunk = missing.slice(i, i + BULK_RATING_CHUNK_SIZE);
      let movies: IMDBMovie[];

      try {
        const response = await this.axios.post<IMDBRadarrProxyResponse>(
          '/movie/bulk',
          chunk
        );
        movies = response.data ?? [];
      } catch (e) {
        logger.warn('Failed to retrieve bulk IMDb ratings', {
          label: 'IMDB Radarr Proxy',
          errorMessage: e.message,
        });
        // Do not cache failures, they will be retried on the next request
        chunk.forEach((tmdbId) => ratings.set(tmdbId, null));
        continue;
      }

      const byTmdbId = new Map(movies.map((movie) => [movie.TmdbId, movie]));

      for (const tmdbId of chunk) {
        const imdb = byTmdbId.get(tmdbId)?.MovieRatings?.Imdb;
        const rating = imdb && imdb.Count > 0 ? imdb.Value : null;
        ratings.set(tmdbId, rating);
        this.ratingCache.set(
          this.bulkRatingCacheKey(tmdbId),
          rating,
          BULK_RATING_CACHE_TTL
        );
      }
    }

    return ratings;
  }

  private bulkRatingCacheKey(tmdbId: number): string {
    return `bulk-rating:${tmdbId}`;
  }
}

export default IMDBRadarrProxy;
