'use strict';

const BaseClient = require('./BaseClient');
const ApplicationCommand = require('../structures/ApplicationCommand');
const CommandInteraction = require('../structures/CommandInteraction');
const { Events, ApplicationCommandOptionType, InteractionType, InteractionResponseType } = require('../util/Constants');

let sodium;

function transformCommand(command) {
  return {
    name: command.name,
    description: command.description,
    options: command.options?.map(function m(o) {
      return {
        type: ApplicationCommandOptionType[o.type],
        name: o.name,
        description: o.description,
        default: o.default,
        required: o.required,
        choices: o.choices,
        options: o.options?.map(m),
      };
    }),
  };
}

/**
 * Interaction client is used for interactions.
 *
 * @example
 * const client = new InteractionClient({
 *   token: ABC,
 *   publicKey: XYZ,
 * });
 *
 * client.on('interactionCreate', () => {
 *   // automatically handles long responses
 *   if (will take a long time) {
 *     doSomethingLong.then((d) => {
 *       interaction.reply({
 *         content: 'wow that took long',
 *       });
 *     });
 *   } else {
 *     interaction.reply('hi!');
 *   }
 * });
 * ```
 */
class InteractionClient extends BaseClient {
  /**
   * @param {Options} options Options for the client.
   * @param {undefined} client For internal use.
   */
  constructor(options, client) {
    super(options);

    Object.defineProperty(this, 'token', {
      value: options.token,
      writable: true,
    });

    if (client) {
      this.client = client;
    } else {
      this.client = this;
      this.interactionClient = this;

      Object.defineProperty(this, 'clientID', {
        value: options.clientID,
        writable: true,
      });

      Object.defineProperty(this, 'publicKey', {
        value: options.publicKey ? Buffer.from(options.publicKey, 'hex') : undefined,
        writable: true,
      });
    }
  }

  /**
   * Fetch registered slash commands.
   * @param {Snowflake} [guildID] Optional guild ID.
   * @returns {ApplicationCommand[]}
   */
  async fetchCommands(guildID) {
    const clientID = this.client.interactionClient.clientID || (await this.client.fetchApplication()).id;
    let path = this.client.api.applications(clientID);
    if (guildID) {
      path = path.guilds(guildID);
    }
    const commands = await path.commands.get();
    return commands.map(c => new ApplicationCommand(this, c, guildID));
  }

  /**
   * Set all the commands for the application or guild.
   * @param {Object[]} commands The command descriptor.
   * @param {Snowflake} [guildID] Optional guild ID.
   * @returns {ApplicationCommand[]} The commands.
   */
  async setCommands(commands, guildID) {
    const clientID = this.client.interactionClient.clientID || (await this.client.fetchApplication()).id;
    let path = this.client.api.applications(clientID);
    if (guildID) {
      path = path.guilds(guildID);
    }
    const cs = await path.commands.post({
      data: commands.map(transformCommand),
    });
    return cs.map(c => new ApplicationCommand(this, c, guildID));
  }

  /**
   * Create a command.
   * @param {Object} command The command descriptor.
   * @param {Snowflake} [guildID] Optional guild ID.
   * @returns {ApplicationCommand} The created command.
   */
  async createCommand(command, guildID) {
    const clientID = this.client.interactionClient.clientID || (await this.client.fetchApplication()).id;
    let path = this.client.api.applications(clientID);
    if (guildID) {
      path = path.guilds(guildID);
    }
    const c = await path.commands.post({
      data: transformCommand(command),
    });
    return new ApplicationCommand(this, c, guildID);
  }

  /**
   * Update a command.
   * @param {Snowflake} commandID The command descriptor.
   * @param {Object} command The command descriptor.
   * @param {Snowflake} [guildID] Optional guild ID.
   * @returns {ApplicationCommand} The updated command.
   */
  async updateCommand(commandID, command, guildID) {
    const clientID = this.client.interactionClient.clientID || (await this.client.fetchApplication()).id;
    let path = this.client.api.applications(clientID);
    if (guildID) {
      path = path.guilds(guildID);
    }
    const commandObject = transformCommand(command);
    delete commandObject.name;
    const c = await path.commands(commandID).patch({
      data: commandObject,
    });
    return new ApplicationCommand(this, c, guildID);
  }

  /**
   * Delete a command.
   * @param {Snowflake} commandID The command descriptor.
   * @param {Snowflake} [guildID] Optional guild ID.
   */
  async deleteCommand(commandID, guildID) {
    const clientID = this.client.interactionClient.clientID || (await this.client.fetchApplication()).id;
    let path = this.client.api.applications(clientID);
    if (guildID) {
      path = path.guilds(guildID);
    }
    await path.commands(commandID).delete();
  }

  handle(data) {
    switch (data.type) {
      case InteractionType.PING:
        return {
          type: InteractionResponseType.PONG,
        };
      case InteractionType.APPLICATION_COMMAND: {
        let timedOut = false;
        let resolve;
        const directPromise = new Promise(r => {
          resolve = r;
          this.client.setTimeout(() => {
            timedOut = true;
            r({
              type: InteractionResponseType.ACKNOWLEDGE_WITH_SOURCE,
            });
          }, 250);
        });

        const syncHandle = {
          acknowledge({ hideSource }) {
            if (!timedOut) {
              resolve({
                type: hideSource
                  ? InteractionResponseType.ACKNOWLEDGE
                  : InteractionResponseType.ACKNOWLEDGE_WITH_SOURCE,
              });
            }
          },
          reply(resolved) {
            if (timedOut) {
              return false;
            }
            resolve({
              type: resolved.hideSource
                ? InteractionResponseType.CHANNEL_MESSAGE
                : InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: resolved.data,
            });
            return true;
          },
        };

        const interaction = new CommandInteraction(this.client, data, syncHandle);

        /**
         * Emitted when an interaction is created.
         * @event Client#interactionCreate
         * @param {Interaction} interaction The interaction which was created.
         */
        this.client.emit(Events.INTERACTION_CREATE, interaction);

        return directPromise;
      }
      default:
        throw new RangeError('Invalid interaction data');
    }
  }

  /**
   * An express-like middleware factory which can be used
   * with webhook interactions.
   * @returns {Function} The middleware function.
   */
  middleware() {
    return async (req, res) => {
      const timestamp = req.get('x-signature-timestamp');
      const signature = req.get('x-signature-ed25519');

      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);

      if (sodium === undefined) {
        sodium = require('../util/Sodium');
      }
      if (
        !sodium.methods.verify(
          Buffer.from(signature, 'hex'),
          Buffer.concat([Buffer.from(timestamp), body]),
          this.publicKey,
        )
      ) {
        res.status(401).end();
        return;
      }

      const data = JSON.parse(body.toString());

      const result = await this.handle(data);
      res.status(200).end(JSON.stringify(result));
    };
  }

  async handleFromGateway(data) {
    const result = await this.handle(data);

    await this.client.api.interactions(data.id, data.token).callback.post({
      data: result,
      query: { wait: true },
    });
  }
}

module.exports = InteractionClient;
