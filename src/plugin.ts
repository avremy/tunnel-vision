import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { VpnToggle } from "./actions/vpn-toggle";

streamDeck.logger.setLevel(LogLevel.INFO);
streamDeck.actions.registerAction(new VpnToggle());
streamDeck.connect();
