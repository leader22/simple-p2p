import _debug from "debug";
import EventEmitter from "eventemitter3";

const debug = _debug("simple-p2p:receiver");

/**
 * Events
 * @fires MediaHandler#replace
 * @fires MediaHandler#end
 * @fires MediaHandler#@stats
 */
class Receiver extends EventEmitter {
  private _ended: boolean;
  private _track: MediaStreamTrack;
  private _tidx: number;

  constructor(track: MediaStreamTrack, tidx: number) {
    super();

    this._ended = false;
    this._track = track;
    this._tidx = tidx;
  }

  get ended() {
    return this._ended;
  }

  get track() {
    return this._track;
  }

  get kind() {
    return this._track.kind;
  }

  async getStats(): Promise<RTCStatsReport> {
    debug("getStats()");

    if (this._ended) throw new Error("Already ended receiver!");

    const stats = (await new Promise((resolve, reject) => {
      this.emit("@stats", this._tidx, resolve, reject);
    })) as RTCStatsReport;
    return stats;
  }

  _replacedBySender() {
    debug("_replacedBySender()");
    this.emit("replace");
  }

  _endedBySender() {
    debug("_endedBySender()");

    this._ended = true;
    this.emit("ended");
  }
}

export default Receiver;
