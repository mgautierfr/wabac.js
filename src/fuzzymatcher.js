import { jsonToQueryParams } from "warcio";

function joinRx(rxStr) {
  return new RegExp("[?&]" + rxStr.map(x => "(" + x + ")").join("|"), "gi");
}

const MAX_ARG_LEN = 1024;

const SPLIT_BASE_RX = /\[\d]+/;

const DEFAULT_RULES =
[
  {
    "match": /\/\/.*(?:gcs-vimeo|vod|vod-progressive)\.akamaized\.net.*?\/([\d/]+\.mp4)/,
    "fuzzyCanonReplace": "//vimeo-cdn.fuzzy.replayweb.page/$1",
    "split": ".net",
  },
  {
    "match": /\/\/.*player.vimeo.com\/(video\/[\d]+)\?.*/i,
    "fuzzyCanonReplace": "//vimeo.fuzzy.replayweb.page/$1"
  },
  {
    "match": /www.\washingtonpost\.com\/wp-apps\/imrs.php/,
    "args": [["src"]],
  },
  {
    "match": /(static.wixstatic.com\/.*\.[\w]+\/v1\/fill\/)(w_.*)/,
    "replace": "$1?_args=$2",
    "split": "/v1/fill"
  },
  {
    "match": /(twimg.com\/profile_images\/[^/]+\/[^_]+)_([\w]+\.[\w]+)/,
    "replace": "$1=_args=$2",
    "split": "_",
    "splitLast": true
  },
  // YouTube
  {
    "match": /^https?:\/\/(?:www\.)?(youtube\.com\/embed\/[^?]+)[?].*/i,
    "replace": "$1"
  },
  {
    "match": /^(https?:\/\/(?:www\.)?)(youtube\.com\/@[^?]+)[?].*/i,
    "fuzzyCanonReplace": "$1$2"
  },
  {
    "match": /\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/(get_video_info)/i,
    "fuzzyCanonReplace": "//youtube.fuzzy.replayweb.page/$1",
    "args": [["video_id"]],
  },
  {
    "match": /\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/(youtubei\/v1\/[^?]+\?).*(videoId[^&]+).*/i,
    "fuzzyCanonReplace": "//youtube.fuzzy.replayweb.page/$1$2",
    "args": [["videoId"]]
  },
  {
    "match": /\/\/.*googlevideo.com\/(videoplayback)/i,
    "fuzzyCanonReplace": "//youtube.fuzzy.replayweb.page/$1",
    "args": [
      ["id", "itag"],
      ["id"]
    ],
    "fuzzyArgs": true
  },
  {
    "match": /facebook\.com\/ajax\/pagelet\/generic.php\/photoviewerinitpagelet/i,
    "args": [[{"arg": "data",
      "keys": ["query_type", "fbid", "v", "cursor", "data"]}]]
  },
  {
    "match": /(twitter.com\/[^/]+\/status\/[^?]+)(\?.*)/,
    "fuzzyCanonReplace": "$1"
  },
  // Facebook
  {
    "match": /facebook\.com\/ajax\//i,
    "fuzzySet": true
  },
  // {
  //   "match": /facebook\.com\/api\/graphql/i,
  //   "args": [["fb_api_req_friendly_name"]],
  //   //"args": [["variables", "doc_id"]],
  //   //"fuzzyArgs": true
  // },
  // {
  //   "match": /facebook\.com\/api\/graphqlbatch/i,
  //   "args": [["batch_name", "queries"], ["batch_name"]]
  // },
  // {
  //   "match": /facebook\.com\/ajax\/navigation/i,
  //   "args": [["route_url", "__user"], ["route_url"]]
  // },
  // {
  //   "match": /facebook\.com\/ajax\/route-definition/i,
  //   "args": [["route_url", "__user"], ["route_url"]]
  // },
  // {
  //   "match": /facebook\.com\/ajax\/bulk-route-definitions/i,
  //   "args": [["route_urls[0]", "__user"], ["route_urls[0]"]]
  // },
  // {
  //   "match": /facebook\.com\/ajax\/relay-ef/i,
  //   "args": [["queries[0]", "__user"], ["queries[0]"]]
  // },
  // {
  //   "match": /facebook\.com\/videos\/vodcomments/i,
  //   "args": [["eft_id"]],
  // },
  // {
  //   "match": /facebook\.com\/ajax\.*/i,
  //   "replaceQuery": /([?&][^_]\w+=[^&]+)/g,
  // },
  // {"match": /plus\.googleapis\.com\/u\/\/0\/_\/widget\/render\/comments/i,
  //   "args": [["href", "stream_id", "substream_id"]]
  // },

  // Generic Rules -- should be last
  {
    "match": joinRx([
      "(callback=jsonp)[^&]+(?=&|$)",
      "((?:\\w+)=jquery)[\\d]+_[\\d]+",
      "utm_[^=]+=[^&]+(?=&|$)",
      "(_|cb|_ga|\\w*cache\\w*)=[\\d.-]+(?=$|&)"
    ]),
    "replace": ""
  },
  {
    "match": /(\.(?:js|webm|mp4|gif|jpg|png|css|json|m3u8))\?.*/i,
    "replace": "$1",
    "maxResults": 2
  }
];

// ===========================================================================
class FuzzyMatcher {
  constructor(rules) {
    this.rules = rules || DEFAULT_RULES;
  }

  getRuleFor(reqUrl) {
    let rule;

    const matchUrl = reqUrl.indexOf("?") === -1 ? reqUrl + "?" : reqUrl;

    for (const testRule of this.rules) {
      if (matchUrl.match(testRule.match)) {
        rule = testRule;
        break;
      }
    }

    let fuzzyCanonUrl = reqUrl;

    if (rule && rule.fuzzyCanonReplace) {
      fuzzyCanonUrl = reqUrl.replace(rule.match, rule.fuzzyCanonReplace);
    }

    const split = rule && rule.split || "?";
    const inx = rule && rule.splitLast ? reqUrl.lastIndexOf(split) : reqUrl.indexOf(split);
    const prefix = inx > 0 ? reqUrl.slice(0, inx + split.length) : reqUrl;

    return {prefix, rule, fuzzyCanonUrl};
  }

  getFuzzyCanonsWithArgs(reqUrl) {
    let { fuzzyCanonUrl, prefix, rule } = this.getRuleFor(reqUrl);

    if (fuzzyCanonUrl === reqUrl) {
      fuzzyCanonUrl = prefix;
    }

    const urls = [];

    if (rule && rule.args) {
      const fuzzUrl = new URL(fuzzyCanonUrl);
      const origUrl = new URL(reqUrl);

      for (const args of rule.args) {
        const query = new URLSearchParams();

        for (const arg of args) {
          query.set(arg, origUrl.searchParams.get(arg) || "");
        }
        fuzzUrl.search = query.toString();
        urls.push(fuzzUrl.href);
      }
      return urls;
    }

    return [fuzzyCanonUrl];
  }
}

const fuzzyMatcher = new FuzzyMatcher();

export { FuzzyMatcher, fuzzyMatcher };
