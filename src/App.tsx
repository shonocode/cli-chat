import PWABadge from "./PWABadge.tsx";
import { useState, useEffect, useRef } from "react";
import Peer, { DataConnection } from "peerjs";

const App = () => {
  const [peerId, setPeerId] = useState<string>("");
  const [peer, setPeer] = useState<Peer | null>(null);
  const [conn, setConn] = useState<DataConnection | null>(null);
  const [messages, setMessages] = useState<
    { from: "local" | "remote"; text: string }[]
  >([]);
  const messageRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const peer = new Peer();
    setPeer(peer);

    peer.on("open", (id) => {
      setPeerId(id);
    });

    peer.on("connection", (connection) => {
      setConn(connection);
      setupConnection(connection);
    });

    return () => {
      peer.disconnect();
    };
  }, []);

  const setupConnection = (connection: DataConnection) => {
    connection.on("data", (data) => {
      setMessages((prevMessages) => [
        ...prevMessages,
        { from: "remote", text: data },
      ]);
    });
  };

  const sendMessage = () => {
    if (conn && messageRef.current?.value) {
      conn.send(messageRef.current.value);
      setMessages((prevMessages) => [
        ...prevMessages,
        { from: "local", text: messageRef.current.value },
      ]);
      messageRef.current.value = "";
    }
  };

  const connectToPeer = (peerId: string) => {
    if (peer) {
      const connection = peer.connect(peerId);
      connection.on("open", () => {
        setConn(connection);
        setupConnection(connection);
      });
    }
  };

  return (
    <div>
      <h1>PeerJS Chat App</h1>
      <p>Your ID: {peerId}</p>
      <input
        type="text"
        placeholder="Peer ID to connect"
        onBlur={(e) => connectToPeer(e.target.value)}
      />
      <div>
        {messages.map((msg, index) => (
          <div
            key={index}
            style={{ textAlign: msg.from === "local" ? "right" : "left" }}
          >
            <span>{msg.text}</span>
          </div>
        ))}
      </div>
      <input type="text" ref={messageRef} placeholder="Type your message" />
      <button onClick={sendMessage}>Send</button>
      <PWABadge />
    </div>
  );
};

export default App;
