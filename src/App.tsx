import PWABadge from "./PWABadge.tsx";
import { useState, useEffect } from "react";
import Peer, { DataConnection } from "peerjs";
import "./App.css";
import {
  OFFLINE,
  ONLINE,
  LOGGED_IN,
  CONNECTING,
  CONNECTED,
  CLI_CHAT,
  CLI_CHAT_AA,
} from "./consts.ts";

const App = () => {
  const [status, setStatus] = useState<number>(OFFLINE);
  const [peerId, setPeerId] = useState<string>("");
  const [peer, setPeer] = useState<Peer | null>(null);
  const [conn, setConn] = useState<DataConnection | null>(null);
  const [pendingConnection, setPendingConnection] =
    useState<DataConnection | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  useEffect(() => {
    const checkStatus = async () => {
      setMessages([CLI_CHAT_AA]);

      if (navigator.onLine) {
        setStatus(ONLINE);
        addTerminal(
          CLI_CHAT,
          "Welcome to CLI-CHAT. Type 'help' to see the list of commands."
        );
      }
    };

    checkStatus();
  }, []);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();

      const command = e.currentTarget.value;

      addTerminal(peerId, command);

      runCommand(command);
      e.currentTarget.value = "";
    }
  };

  const runCommand = (command: string) => {
    if (command.startsWith("login")) {
      const parts = command.split(" ");
      const id = parts.length > 1 ? parts[1] : "";
      switch (status) {
        case OFFLINE:
          addTerminal(CLI_CHAT, "You are currently offline.");
          break;
        case ONLINE:
          initializePeer(id);
          break;
        case LOGGED_IN:
          addTerminal(CLI_CHAT, "You are already logged in.");
          break;
        default:
          break;
      }
    }

    if (command.startsWith("connect")) {
      if (status === LOGGED_IN) {
        const id = command.split(" ")[1];
        id ? connectToPeer(id) : addTerminal(CLI_CHAT, "need a destination id.");
      }
    }

    if (status === CONNECTING) {
      confirmConnect(command);
    }

    if (status === CONNECTED) {
      if (command === "disconnect") {
        conn?.close();
        setStatus(LOGGED_IN);
      }
      sendMessage(command);
    }

    if (command === "logout") {
      setStatus(ONLINE);
      peer?.destroy();
      addTerminal(CLI_CHAT, "logout.");
      setPeer(null);
    }

    if (command === "help") {
      addTerminal(CLI_CHAT, "Commands: login, connect, disconnect, logout, help");
    }
  };

  const initializePeer = (id: string) => {
    setIsProcessing(true);
    const peer = new Peer(id);
    setPeer(peer);

    peer.on("open", (id) => {
      setPeerId(id);
      setStatus(LOGGED_IN);
      addTerminal(CLI_CHAT, `Your ID has been set to ${id}`);
      setIsProcessing(false);
    });

    peer.on("connection", (connection) => {
      connection.on("open", () => {
        setStatus(CONNECTING);
        setPendingConnection(connection);
        addTerminal(
          CLI_CHAT,
          `${connection.peer} wants to connect. Do you accept?(y/n)`
        );
      });
    });

    peer.on("disconnected", () => {
      addTerminal(CLI_CHAT, "disconnected.");
    });

    peer.on("close", () => {
      setStatus(ONLINE);
      addTerminal(CLI_CHAT, "Connection closed.");
    });

    peer.on("error", (err) => {
      addTerminal(CLI_CHAT, err.message);
      setIsProcessing(false);
    });
  };

  const connectToPeer = (destinationPeerId: string) => {
    if (peer) {
      const connection = peer.connect(destinationPeerId);

      connection.on("open", () => {
        setStatus(CONNECTED);
        setConn(connection);
        addTerminal(CLI_CHAT, `Connecting to ${destinationPeerId} ...`);

        connection.on("data", (data) => {
          addTerminal(connection.peer, data as string);
        });
      });

      connection.on("error", (err) => {
        setStatus(LOGGED_IN);
        addTerminal(CLI_CHAT, `Error connecting to ${destinationPeerId}: ${err.message}`);
      });

      connection.on("close", () => {
        setStatus(LOGGED_IN);
        addTerminal(CLI_CHAT, `Connection to ${destinationPeerId} closed.`);
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
        addTerminal(connection.peer, data as string);
      });

      connection.send(`${CLI_CHAT}> ${peerId} is connected with you.\n`);

      addTerminal(CLI_CHAT, `Connected to ${connection.peer}.`);

      setPendingConnection(null);
    } else if (command === "n") {
      connection.close();

      setStatus(LOGGED_IN);
      setPendingConnection(null);
      addTerminal(CLI_CHAT, `Connection to ${connection.peer} canceled.`);
    } else {
      addTerminal(CLI_CHAT, "Invalid response. Please enter 'y' or 'n'.");
    }
  };

  const sendMessage = (message: string) => {
    if (conn && conn.open) {
      conn.send(message);
    }
  };

  const addTerminal = (sender: string, message: string) => {
    setMessages(prevMessages => [...prevMessages, `${sender}> ${message}\n`]);
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
