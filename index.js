#!/usr/bin/env node
const Promise = require('bluebird');
const debug = require('debug')('pogono');
const fs = require('fs');
const path = require('path');
const request = require('request-promise');
const moment = require('moment');
const _ = require('lodash');
const errors = require('request-promise/errors');

const args = require('./args.js');
const config = _.assign({
    filteredPokemonIds: null,
    filteredAddressKeywords: null,
    trustedUserId: null,
    minLatitude: 24.783617562869416,
    maxLatitude: 24.82740393838965,
    minLongitude: 120.93629837036131,
    maxLongitude: 121.0129451751709,
    queryInterval: 10000,
    telegramChatId: null,
    telegramBotToken: null,
    telegramBotEnable: false,
    telegramTimeout: 30000,
    source: 'pokeradar',
    poGoMapAPI: null,
    IVMoveEnable: true,
    IVPokemonIds: null,
    minIVPerfection: 0,
}, require(path.resolve(args.config)));

if (config.centerLatitude && config.centerLongitude && config.nearbyDistance) {
    config.minLatitude = config.centerLatitude - config.nearbyDistance/110.574;
    config.maxLatitude = config.centerLatitude + config.nearbyDistance/110.574;
    config.minLongitude = config.centerLongitude - config.nearbyDistance/(111.32 * Math.cos(config.centerLatitude));
    config.maxLongitude = config.centerLongitude + config.nearbyDistance/(111.32 * Math.cos(config.centerLatitude));
};

const TelegramBot = require('./telegram_bot.js');
const pokemonNames = require('./pokemon_names.js');
const pokemonMoves = require('./pokemon_moves.js');
const pokemonStickers = require('./stickers.js');
const getReverseGeocode = require('./get_reverse_geocode.js');
const messageTemplate = fs.readFileSync('./templates/message.md.template', 'utf-8');
const ivMoveTemplate = fs.readFileSync('./templates/iv_move.md.template', 'utf-8');

let telegramBot = config.telegramBotEnable ? new TelegramBot(config) : null;
let sentPokemons = [];

const replace = function(template, replacements) {
    for (let placeholder in replacements) {
        template = template.replace(new RegExp(`{${placeholder}}`, 'g'), replacements[placeholder]);
    }
    return template;
}

const generateMessage = function(pokemon) {
    let iv_move = '';
    let should_display = _.reduce([
        pokemon.individualAttack,
        pokemon.individualDefense,
        pokemon.individualStamina,
        pokemon.move1,
        pokemon.move2
    ], function(sum, c) {
        return sum && !_.isNil(c) && !_.isNaN(c);
    }, true);
    if (config.IVMoveEnable && should_display) {
        iv_move = replace(ivMoveTemplate, {
            individual_attack: pokemon.individualAttack,
            individual_defense: pokemon.individualDefense,
            individual_stamina: pokemon.individualStamina,
            iv_perfection: pokemon.IVPerfection,
            move_1_en: pokemon.move1.en,
            move_2_en: pokemon.move2.en,
            move_1_zh: pokemon.move1.zh,
            move_2_zh: pokemon.move2.zh
        });
    }
    return replace(messageTemplate, {
        pokemon_id: pokemon.pokemonId,
        pokemon_name_zh: pokemon.pokemonName.zh,
        pokemon_name_en: pokemon.pokemonName.en,
        address_components: pokemon.reverseGeocode.components.map((x) => '#' + x).join(' '),
        address: pokemon.reverseGeocode.formatted_address,
        remaining_time: pokemon.remainingTime.format('mm:ss'),
        direction: pokemon.direction,
        until: pokemon.until.format('YYYY-MM-DD HH:mm:ss'),
        iv_move: iv_move
    });
}

const pushNotifications = function(pokemons) {
    sentPokemons = _.filter(sentPokemons, (s) => s.until.isAfter(moment()));

    // remove sent pokemons
    debug('fetch', 'fetch pokemons from the provider:', pokemons.length, 'pokemons left');
    let filteredPokemons = _.filter(pokemons, function (p) {
        return !_.find(sentPokemons, (s) => p.uniqueId == s.uniqueId) && p.remainingTime.diff(moment.utc(0)) > 0;
    });
    debug('filter', 'filter by sent pokemons:', filteredPokemons.length, 'pokemons left');

    if (config.IVPokemonIds !== null) {
        filteredPokemons = _.filter(filteredPokemons, function(pokemon) {
            if (config.IVPokemonIds === 'all') {
                return pokemon.IVPerfection >= config.minIVPerfection;
            } else {
                return !_.includes(config.IVPokemonIds, pokemon.pokemonId) || pokemon.IVPerfection >= ( pokemon.pokemonName.iv || config.minIVPerfection );
            }
        });
    }
    debug('filter', 'filter by IV', filteredPokemons.length, 'pokemons left');

    debug('get reverse geocode');
    return Promise.each(filteredPokemons, function(p) {
            return getReverseGeocode(p.latitude, p.longitude)
                .then((reverseGeocode) => p.reverseGeocode = reverseGeocode);
        })
        .then(function filterByAddressKeywords() {
            filteredPokemons = _.filter(filteredPokemons, function(p) {
                if (config.filteredAddressKeywords) {
                    let keywords = _.isArray(config.filteredAddressKeywords) ? config.filteredAddressKeywords : [config.filteredAddressKeywords];
                    for (let keyword of keywords) {
                        if (p.reverseGeocode.formatted_address.includes(keyword) || p.reverseGeocode.components.join(',').includes(keyword)) {
                            return true;
                        }
                    }
                    sentPokemons.push(p);
                    return false;
                }
                return true;
            });
            debug('filter', 'filter by address keywords', config.filteredAddressKeywords, ':', filteredPokemons.length, 'pokemons left');
            debug('notify', filteredPokemons.length, 'pokemons');
            return filteredPokemons;
        })
        .each(function(p) {
            let message = generateMessage(p);
            console.log(moment().format(), 'message:', message);

            if (config.telegramBotEnable && telegramBot && config.telegramChatId) {
                // push a notification
                return Promise.resolve()
                    .then(() => telegramBot.sendSticker(config.telegramChatId, pokemonStickers[p.pokemonId], { disable_notification: true }))
                    .timeout(config.telegramTimeout)
                    .then(() => telegramBot.sendLocation(config.telegramChatId, p.latitude, p.longitude, { disable_notification: true }))
                    .timeout(config.telegramTimeout)
                    .then(() => telegramBot.sendMessage(config.telegramChatId, message, { parse_mode: 'Markdown' }))
                    .timeout(config.telegramTimeout)
                    .then(() => sentPokemons.push(p))
                    .catch(function(err) {
                        console.error(moment().format(), 'telegram bot error:', err.message);
                    })
            } else {
                sentPokemons.push(p);
            }
        });
}

let Provider = require('./providers/' + config.source);
let provider = new Provider(config);

debug('request loop starts');

provider
    .init()
    .then(function requestLoop() {
        return provider
            .getPokemons()
            .then(pushNotifications)
            .catch(errors.StatusCodeError, function (reason) {
                console.error(moment().format(), 'status code error:', reason.message);
            })
            .catch(errors.RequestError, function (reason) {
                console.error(moment().format(), 'request error:', reason.message);
            })
            .catch(SyntaxError, function(reason) {
                console.error(moment().format(), 'syntax error:', reason.message);
            })
            .delay(config.queryInterval)
            .then(requestLoop);
    })
    .catch(function(reason) {
        console.error(moment().format(), reason);
        // TODO: use TelegramBot#stopPolling instead
        telegramBot._polling.abort = true;
        console.error('the program has been terminated')
    });
