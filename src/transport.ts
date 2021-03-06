import _debug from "debug";
import EventEmitter from "eventemitter3";
import { promised, PromisedDataChannel } from "enhanced-datachannel";
import MediaHandler from "./media-handler";
import DataHandler from "./data-handler";

const debug = _debug("simple-p2p:transport");

interface NegotiaionSDPPayload {
  type: "offer" | "answer";
  data: RTCSessionDescription;
}
interface NegotiaionCandidaatePayload {
  type: "candidate";
  data: RTCIceCandidate;
}
type NegotiaionPayload = NegotiaionSDPPayload | NegotiaionCandidaatePayload;
type ConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

/**
 * Events
 * @fires Transport#open
 * @fires Transport#negotiation
 * @fires Transport#connectionStateChange
 * @fires Transport#close
 * @fires Transport#error
 */
class Transport extends EventEmitter {
  private _closed: boolean;
  private _connectionState: ConnectionState;
  private _pc: RTCPeerConnection;
  private _signaling: PromisedDataChannel;
  private _mediaHandler: MediaHandler;
  private _dataHandler: DataHandler;

  constructor(pc: RTCPeerConnection) {
    super();

    this._closed = false;
    this._connectionState = "new";

    this._pc = pc;
    this._pc.addEventListener("icecandidate", this, false);
    this._pc.addEventListener("iceconnectionstatechange", this, false);
    // only Chrome has this event
    this._pc.addEventListener("connectionstatechange", this, false);

    // use this data channel for signaling
    this._signaling = promised(
      pc.createDataChannel("signaling", { negotiated: true, id: 0 })
    );
    this._signaling.on("open", () => this.emit("open"));
    this._signaling.on("close", () => debug("signaling close"));
    this._signaling.on("error", err => {
      debug("signaling error", err);
      this.emit("error", err);
    });

    // use these handlers for rtc
    this._mediaHandler = new MediaHandler(this._pc, this._signaling);
    this._dataHandler = new DataHandler(this._pc, this._signaling);
  }

  get closed() {
    return this._closed;
  }

  get connectionState() {
    return this._connectionState;
  }

  get mediaHandler() {
    return this._mediaHandler;
  }
  get dataHandler() {
    return this._dataHandler;
  }

  close() {
    debug("close()");

    this._closed = true;
    this._updateConnectionState("closed");

    this._mediaHandler._transportClose();
    this._dataHandler._transportClose();

    this._pc.close();
    this._pc.removeEventListener("icecandidate", this, false);
    this._pc.removeEventListener("iceconnectionstatechange", this, false);
    this._pc.removeEventListener("connectionstatechange", this, false);

    this.emit("close");
  }

  handleEvent(ev: Event) {
    switch (ev.type) {
      case "icecandidate":
        return this._handleCandidateEvent(ev as RTCPeerConnectionIceEvent);
      case "iceconnectionstatechange":
        return this._handleIceConnectionStateChangeEvent();
      case "connectionstatechange":
        return this._handleConnectionStateChangeEvent();
    }
  }

  async startNegotiation(iceRestart = false) {
    debug("startNegotiation() iceRestart ?", iceRestart);

    if (this._closed) throw new Error("Transport closed!");

    await this._pc
      .createOffer({ iceRestart })
      .then(offer => this._pc.setLocalDescription(offer));

    // must not be happend
    if (this._pc.localDescription === null)
      throw new Error("Can't generate offer SDP!");

    debug("emit offer SDP");
    debug(this._pc.localDescription.sdp);
    this.emit("negotiation", {
      type: "offer",
      data: this._pc.localDescription
    });
  }

  async handleNegotiation(payload: NegotiaionPayload) {
    debug("handleNegotiation()");

    if (this._closed) {
      debug("transport already closed, ignore");
      return;
    }

    switch (payload.type) {
      case "candidate":
        return await this._handleCandidate(payload.data);
      case "offer":
        return await this._handleOffer(payload.data);
      case "answer":
        return await this._handleAnswer(payload.data);
      default:
        debug("Undefined payload, discard", payload);
    }
  }

  async restartIce() {
    debug("restartIce()");

    if (this._closed) throw new Error("Transport closed!");

    await this.startNegotiation(true);
  }

  updateIceServers(iceServers: RTCIceServer[]) {
    debug("updateIceServers()");
    debug(iceServers);

    if (this._closed) throw new Error("Transport closed!");
    // Firefox does not support. at least Firefox ~74
    if (typeof RTCPeerConnection.prototype.setConfiguration !== "function")
      throw new Error("Your browser does not support setConfiguraton()...");

    const config = this._pc.getConfiguration();
    config.iceServers = iceServers;
    this._pc.setConfiguration(config);
  }

  async getStats(): Promise<RTCStatsReport> {
    debug("getStats()");

    if (this._closed) throw new Error("Transport closed!");

    const stats = await this._pc.getStats();
    return stats;
  }

  private async _handleOffer(offer: RTCSessionDescription) {
    debug("handle offer SDP");

    if (offer.type !== "offer")
      throw new Error("Received SDP is not an offer!");

    debug(offer.sdp);
    await Promise.all([
      this._pc.setRemoteDescription(offer),
      this._pc
        .createAnswer()
        .then(answer => this._pc.setLocalDescription(answer))
    ]);

    // must not be happend
    if (this._pc.localDescription === null)
      throw new Error("Can't generate answer SDP!");

    debug("emit answer SDP");
    debug(this._pc.localDescription.sdp);
    this.emit("negotiation", {
      type: "answer",
      data: this._pc.localDescription
    });
  }

  private async _handleAnswer(answer: RTCSessionDescription) {
    debug("handle answer SDP");

    if (answer.type !== "answer")
      throw new Error("Received SDP is not an answer!");

    debug(answer.sdp);
    await this._pc.setRemoteDescription(answer);
  }

  private async _handleCandidate(candidate: RTCIceCandidate) {
    debug("handle candidate");
    debug(candidate.candidate);
    await this._pc.addIceCandidate(candidate);
  }

  private _handleCandidateEvent(ev: RTCPeerConnectionIceEvent) {
    if (ev.candidate === null) return;
    // Firefox 68~ emits this but others can not recognize...
    if (ev.candidate.candidate === "") return;
    this.emit("negotiation", { type: "candidate", data: ev.candidate });
  }

  private _handleIceConnectionStateChangeEvent() {
    debug("iceConnectionState", this._pc.iceConnectionState);

    const newState = ({
      new: null,
      checking: "connecting",
      connected: "connected",
      completed: "connected",
      disconnected: "disconnected",
      failed: "failed",
      closed: "closed"
    }[this._pc.iceConnectionState] || this._connectionState) as ConnectionState;

    this._updateConnectionState(newState);
  }

  private _handleConnectionStateChangeEvent() {
    debug("connectionState", this._pc.connectionState);

    // use only failure cases for Chrome
    const newState = ({
      new: null,
      connecting: null,
      connected: null,
      disconnected: "disconnected",
      failed: "failed",
      closed: "closed"
    }[this._pc.connectionState] || this._connectionState) as ConnectionState;

    this._updateConnectionState(newState);
  }

  private _updateConnectionState(newState: ConnectionState) {
    // ignore duplicates
    if (this._connectionState === newState) return;

    this._connectionState = newState;
    this.emit("connectionStateChange", this._connectionState);
  }
}

export default Transport;
