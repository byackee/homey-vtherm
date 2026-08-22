Adaptive Thermostat makes any heater regulate properly.

A radiator valve measures the radiator, not the room. A simple thermostat switches
fully on and fully off, so the room swings around the setpoint instead of settling
on it. This app puts a real proportional regulator between a sensor that measures
the temperature you care about and a heater that has no idea where it is.

Pick the sensor in the room. Pick what heats that room. That is the whole setup.


WHAT YOU GET

- Proportional regulation, not on/off. The app computes how much heat the room
  needs and corrects the setpoint it sends to your heater, continuously.
- Presets you actually use: frost protection, eco, comfort, boost, and a manual
  setpoint. Each one has its own temperature, and its own away temperature.
- Open window detection, either from a contact sensor or from a sudden drop in
  temperature. Airing a room stops the heating and closing it starts again, with
  a delay so opening a window for ten seconds does not count.
- Presence and motion. When nobody is home, every preset falls back to its away
  temperature. In a single room, motion can switch between two presets on its own.
- Central boiler control. The app counts how many rooms are calling for heat and
  starts your boiler when enough of them are. It never switches it twice within a
  minute, and it never delays switching it off.
- A full set of Flow cards, including one that fires when the room sensor goes
  quiet — the warning you want when a battery dies in January.


WHAT YOU NEED

- Homey Pro. This app reads and controls the devices you point it at, which needs
  an API permission that Homey Cloud does not offer.
- A temperature sensor and a heater that accepts a target temperature. Both can
  come from any app: Zigbee, Z-Wave, Wi-Fi, it does not matter.
- Optionally, a contact sensor, a motion sensor, a presence sensor, an outdoor
  temperature sensor, and a switch that starts your boiler. Each one the app has
  makes it better; none of them is required.


GOING FURTHER WITH ZIGBEE2MQTT

If your valves are exposed through Zigbee2MQTT, you can give the app access to the
same broker in its settings. It then drives valve opening directly instead of only
sending a setpoint, and pushes the real room temperature into the valve so it stops
regulating on its own thermometer. There is a test button that tells you exactly
what is wrong when the connection fails. Without this, the app still works in full;
it simply sends setpoints.


BEFORE YOU CONTROL A BOILER

Driving a real boiler from a home automation system carries a risk: a boiler running
against closed valves builds pressure. Check that yours has its own safety cut-out
before letting anything switch it. The app never delays switching a boiler off, for
exactly this reason.


CREDITS

The regulation algorithms are ported from Versatile Thermostat, a Home Assistant
integration by Jean-Marc Collin, used under the MIT licence. This app is an
independent implementation for Homey and does not connect to Home Assistant.
