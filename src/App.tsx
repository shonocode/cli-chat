import PWABadge from "./PWABadge.tsx";
import { useState, useEffect, useRef } from "react";
import Peer, { DataConnection } from "peerjs";
import "./App.css";
import * as CONST from "./Consts.ts";

const OFFLINE = 0;
const ONLINE = 1;
const LOGGED_IN = 2;
const CONNECTING = 3;
const CONNECTED = 4;
const CLI_CHAT = "CLI-CHAT";

const App = () => {
  const [status, setStatus] = useState<number>(OFFLINE);
  const [peerId, setPeerId] = useState<string>("");
  const [peer, setPeer] = useState<Peer | null>(null);
  const [conn, setConn] = useState<DataConnection | null>(null);
  const [pendingConnection, setPendingConnection] =
    useState<DataConnection | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const commandRef = useRef<HTMLInputElement>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  useEffect(() => {
    const checkStatus = async () => {
      setMessages([
        `  ___ _    ___     ___ _  _   _ _____
 / __| |  |_ _|__ / __| || | /_\\_   _|
| (__| |__ | |___| (__| __ |/ _ \\| |
 \\___|____|___|   \\___|_||_/_/ \\_\\_|
  CLI based P2P chat app\n
`,
      ]);

      if (!navigator.onLine) {
        setMessages((prevMessages) => [
          ...prevMessages,
          `${CLI_CHAT}> Failed to Connect. Please try again.\n`,
        ]);
        return;
      } else {
        setStatus(ONLINE);
        setMessages((prevMessages) => [
          ...prevMessages,
          `${CLI_CHAT}> Welcome to CLI-CHAT. Enter Your ID.\n`,
        ]);
      }
    };

    checkStatus();
  }, []);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();

      const command = e.currentTarget.value;

      setMessages((prevMessages) => [
        ...prevMessages,
        `${peerId}> ${command}\n`,
      ]);

      runCommand(command);

      e.currentTarget.value = "";
    }
  };

  const runCommand = (command: string) => {
    if (status === ONLINE) {
      initializePeer(command);
    } else if (status === LOGGED_IN) {
      if (command.startsWith("connect ")) {
        const id = command.split(" ")[1];
        connectToPeer(id);
      }
    } else if (status === CONNECTING) {
      confirmConnect(command);
    } else if (status === CONNECTED) {
      sendMessage(command);
    }
  };

  const initializePeer = (id: string) => {
    setIsProcessing(true);
    const peer = new Peer(id);
    setPeer(peer);

    peer.on("open", (id) => {
      setPeerId(id);
      setStatus(LOGGED_IN);
      setMessages((prevMessages) => [
        ...prevMessages,
        `${CLI_CHAT}> Your ID has been set to ${id}\n`,
      ]);
      setIsProcessing(false);
    });

    peer.on("connection", (connection) => {
      setStatus(CONNECTING);
      setPendingConnection(connection);
      setMessages((prevMessages) => [
        ...prevMessages,
        `${CLI_CHAT}> ${connection.peer} wants to connect. Do you accept?(y/n)`,
      ]);
    });

    peer.on("disconnected", () => {
      setMessages((prevMessages) => [
        ...prevMessages,
        `${CLI_CHAT}> disconnected.\n`,
      ]);
    });

    peer.on("close", () => {
      setStatus(ONLINE);
      setMessages((prevMessages) => [
        ...prevMessages,
        `${CLI_CHAT}> logged out.\n`,
      ]);
    });

    peer.on("error", (err) => {
      setMessages((prevMessages) => [
        ...prevMessages,
        `${CLI_CHAT}> ${err.message}\n`,
      ]);
      setIsProcessing(false);
    });
  };

  const connectToPeer = (destinationPeerId: string) => {
    if (peer) {
      const connection = peer.connect(destinationPeerId);

      connection.on("open", () => {
        setStatus(CONNECTED);
        setConn(connection);

        setMessages((prevMessages) => [
          ...prevMessages,
          `${CLI_CHAT}> Connecting to ${destinationPeerId} ...\n`,
        ]);

        connection.on("data", (data) => {
          setMessages((prevMessages) => [...prevMessages, data]);
        });
      });

      connection.on("error", (err) => {
        setStatus(LOGGED_IN);
        setMessages((prevMessages) => [
          ...prevMessages,
          `${CLI_CHAT}> Error connecting to ${destinationPeerId}: ${err.message}\n`,
        ]);
      });

      connection.on("close", () => {
        setStatus(LOGGED_IN);
        setMessages((prevMessages) => [
          ...prevMessages,
          `${CLI_CHAT}> Connection to ${destinationPeerId} is closed.\n`,
        ]);
      });
    }
  };

  const confirmConnect = (command: string) => {
    if (!pendingConnection) {
      return;
    }

    const connection = pendingConnection;

    if (command === "y") {
      setStatus(CONNECTED);
      setConn(connection);
      connection.on("data", (data) => {
        setMessages((prevMessages) => [...prevMessages, data]);
      });

      connection.send(`${CLI_CHAT}> ${peerId} is connected with you.\n`);

      setMessages((prevMessages) => [
        ...prevMessages,
        `${CLI_CHAT}> ${connection.peer} is connected with you.\n`,
      ]);

      setPendingConnection(null);
    } else if (command === "n") {
      connection.close();

      setStatus(LOGGED_IN);
      setPendingConnection(null);
      setMessages((prevMessages) => [
        ...prevMessages,
        `${CLI_CHAT}> Connection canceled.\n`,
      ]);
    } else {
      setMessages((prevMessages) => [
        ...prevMessages,
        `${CLI_CHAT}> Invalid command.\n`,
      ]);
    }
  };

  const sendMessage = (message: string) => {
    if (conn && conn.open) {
      conn.send(`${peerId}> ${message}`);
    }
  };

  return (
    <>
      <div className="crt">
        <div className="terminal">
          <div>
            <div className="message">
              {messages.map((msg, index) => (
                <div key={index}>{msg}</div>
              ))}
            </div>
            <div className="command">
              <label>
                {peerId}
                {"> "}
              </label>
              <input
                className="command-input"
                type="text"
                ref={commandRef}
                onKeyDown={handleInputKeyDown}
                disabled={isProcessing}
              />
            </div>
          </div>
        </div>
      </div>
      <PWABadge />
    </>
  );
};

export default App;
