# obscache

In-memory cache service for Angular with RxJS.

## Example

```typescript
import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { CacheService } from "obscache";
import { Observable } from "rxjs/Observable";

export interface Article {
  id: string;
  title: string;
  content: string;
}

@Injectable()
export class ArticleService {
  constructor(private http: HttpClient, private cache: CacheService) {}

  get(id: string): Observable<Article> {
    return this.cache.get(`article:${id}`)
      .miss(() => ({
        value: this.http.get(`/api/articles/${id}`),
        expires: "15m"
      }));
  }
}
```

The `get` method in the example above returns an observable of article data.
If the cache key `article:${id}` exists in cache, the cached value will be
emitted immediately when it's subscribed. Otherwise the callback of the
`miss` function will be invoked, and the returned value will be cached and
emitted.

Future changes to the cache will notify previously subscribed observers. Say
someone calls the `get` method again after 15 minutes, by then the cached
article data has expired. The `miss` call will be triggered again and latest
article data will be retrieved. It's likely that previously subscribed observers
are also interested in the new data, so they will also get notified. If,
however, you don't want future changes, just call `take(1)` or `first()` before
subscribing.

The returned observable is cold. So no `miss` call will be made if no one
subscribes to it.
