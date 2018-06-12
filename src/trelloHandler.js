var Vue = require('vue');
require('./trelloApiHelper.js');
require('./graphHandler.js')

window.trelloHandler = new Vue({
    el: "#trello",

    data: {
        authenticated: false,
        boards: null,
        selectedBoard: null,
        lists: null,
        cards: null,
        loading: false,
        trelloUrl: null,
    },

    watch: {
        selectedBoard: function(val, oldVal) {
            var vm = this;
            if (0 < val.length) {
                Trello.get('/boards/' + val + '/shortUrl').then(function(data) {
                    vm.trelloUrl = data._value;
                });
                vm.refresh();
            }
        },
    },

    methods: {
        authorize: function() {
            Trello.deauthorize(); //Fix this
            Trello.authorize({
              type: 'popup',
              name: 'Ticket Dependency Graph',
              scope: {
                read: 'true',
                write: 'false' },
              expiration: 'never',
              success: this.authSuccessHandler,
              error: function() {
                  console.warn("Failed authentication")
              }
            });
        },

        authSuccessHandler: function() {
            var vm = this;
            console.log("Successful authentication")
            this.loading = true;
            Trello.get('/member/me/boards').then(function(data) {
                vm.boards = data;
                vm.loading = false;
            })
        },

        refresh: function() {
            var vm = this;
            this.loading = true;
            Trello.get('/boards/' + this.selectedBoard +'/cards').then(function(data) {
                vm.cards = data;
                vm.deleteUselessCards();
                vm.addOrUpdateCards();
                vm.calculateDependenciesAsPromises().then(function(linkDataArray) {
                    window.myDiagram.model.linkDataArray = linkDataArray;
                    vm.loading = false;
                });
            })
        },

        addOrUpdateCards: function() {
            for (var i = 0; i < this.cards.length; i++) {
                var card = this.cards[i];
                window.graphHandler.addOrUpdateTicket(card.idShort, card.name)
            }
        },

        deleteUselessCards: function() {
            var nodes = window.graphHandler.getNodes();
            var toBeRemoved = [];
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i]
                if (!this.isTicketIdInList(node.key)) {
                    toBeRemoved.push(node.key)
                }
            }
            for (var i = 0; i < toBeRemoved.length; i++) {
                window.graphHandler.removeTicket(toBeRemoved[i])
            }
        },

        calculateDependenciesAsPromises: function() {
            var vm = this;
            var linkDataArray = [];
            var promises = [];
            for (var iCard = 0; iCard < vm.cards.length; iCard++) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        vm.getOrCreateDependencyChecklist(vm.cards[iCard]).then(function(checklist) {
                            var ticketIds = vm.getDependentTicketsFromChecklist(checklist);
                            for (var j = 0; j < ticketIds.length; j++) {
                                linkDataArray.push({
                                    from: ticketIds[j].ticketId,
                                    to: vm.getTicketIdFromIdCard(checklist.idCard)
                                });
                            }
                            resolve();
                        });
                    })
                );
            }
            return new Promise(function(resolve, reject) {
                Promise.all(promises).then(function() {
                    resolve(linkDataArray);
                });
            });
        },

        getTicketIdFromIdCard: function(idCard) {
            if (null == this.cards) {
                return null;
            }
            for (var i = 0; i < this.cards.length; i++) {
                if (this.cards[i].id == idCard) {
                    return this.cards[i].idShort;
                }
            }
            return null;
        },

        isTicketIdInList: function(ticketId) {
            for (var i = 0; i < this.cards.length; i++) {
                if (this.cards[i].idShort == ticketId) {
                    return true;
                }
            }
            return false;
        },

        addTrelloDependency: function(parentId, childId) {
            var childCard  = null;
            var parentCard = null;
            if (null == this.cards) {
                console.warn('Fail adding dependency in Trello');
                return false;
            }
            for (var i = 0; i < this.cards.length; i++) {
                if (this.cards[i].idShort == childId) {
                    childCard = this.cards[i];
                }
                if (this.cards[i].idShort == parentId) {
                    parentCard = this.cards[i];
                }
            }
            if (null == childCard || null == parentCard) {
                console.warn('Fail adding dependency in Trello');
                return false;
            }
            this.getOrCreateDependencyChecklist(childCard).then(function(checklist) {
                var checkItem = {
                    "name": parentCard.url
                }
                Trello.post('/checklists/' + checklist.id + '/checkItems', checkItem);
            });
        },

        deleteTrelloDependency: function(parentId, childId) {
            var vm = this;
            var childCard = null;
            if (null == this.cards) {
                console.warn('Fail deleting dependency in Trello');
                return false;
            }
            for (var i = 0; i < this.cards.length; i++) {
                if (this.cards[i].idShort == childId) {
                    childCard = this.cards[i];
                }
            }
            if (null == childCard) {
                console.warn('Fail deleting dependency in Trello');
                return false;
            }
            this.getOrCreateDependencyChecklist(childCard).then(function(checklist) {
                ticketIds = vm.getDependentTicketsFromChecklist(checklist);
                for (var i = 0; i < ticketIds.length; i++) {
                    if (ticketIds[i].ticketId == parentId) {
                        Trello.delete('/checklists/' + checklist.id + '/checkItems/' + ticketIds[i].checkItemId);
                        console.log('Dependency deleted');
                        return;
                    }
                }

            });
        },

        getDependentTicketsFromChecklist: function(checklist) {
            var ticketIds = [];
            if (null == checklist.checkItems) {
                return ticketIds;
            }
            for (var i = 0; i < checklist.checkItems.length; i++) {
                var checkItem = checklist.checkItems[i];
                ticketIds.push({
                    "checkItemId": checkItem.id,
                    "ticketId": this.getTicketIdFromCheckItemName(checkItem.name)
                });
            }
            return ticketIds;
        },

        getTicketIdFromCheckItemName: function(checkItemName) {
            if ("#" == checkItemName[0]) {
                return checkItemName.split("#")[1];
            }
            return parseInt(checkItemName.split("/")[5].split("-")[0]);
        },

        getOrCreateDependencyChecklist: function(card) {
            return new Promise(function(resolve, reject) {
                Trello.get('/cards/' + card.id + '/checklists').then(function(checklists) {
                    for (var k = 0; k < checklists.length; k++) {
                        if ("Dependencies" == checklists[k].name) {
                            return resolve(checklists[k]);
                        }
                    }
                    var checklist = {
                        "name": "Dependencies",
                        "idCard": card.id,
                    }
                    Trello.post('/checklists/', checklist).then(function(data) {
                        resolve(data);
                    });
                });
            });
        }

    }
})
